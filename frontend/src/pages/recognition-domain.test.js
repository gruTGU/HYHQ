import test from "node:test";
import assert from "node:assert/strict";
import { riverResult } from "./PersonalHelpers.js";
import { riverAssistant, initialAssistantQuestion } from "./recognition-domain.js";

test("empty or unrecognized detector output offers an original-image draft before the inconclusive result", () => {
  for (const detections of [[], [{ class_id: 2, eval_category: "unknown" }]]) {
    const task = { id: "river-owner-record", status: "succeeded", detections };
    const result = riverResult(task);
    assert.equal(result.heading, "暂时无法确认");
    const assistant = riverAssistant(task, result);
    assert.equal(assistant.beforeResult, true);
    assert.equal(assistant.context.assessment_job_id, task.id);
    assert.equal(assistant.context.interpretation_mode, "image");
    assert.equal(assistant.context.include_image, true);
    const question = initialAssistantQuestion(assistant.context);
    assert.match(question, /原图/);
    assert.match(question, /未检出可展示/);
    assert.match(question, /不要仅凭照片判断真实水质/);
    assert.ok(question.length <= 500);
  }
});

test("failed detection still offers image observation without claiming a zero-candidate inference", () => {
  const assistant = riverAssistant({ id: "failed-record", status: "failed" }, null);
  assert.equal(assistant.beforeResult, true);
  assert.equal(assistant.context.interpretation_mode, "image");
  assert.match(assistant.context.initial_question, /本次检测未完成/);
  assert.doesNotMatch(assistant.context.initial_question, /模型本次未检出/);
});

test("recognized candidates retain the model-result context and selected original image", () => {
  const task = {
    id: "candidate-record", status: "succeeded", image_width: 100, image_height: 100,
    detections: [{ class_id: 9, eval_category: "floating_debris", confidence: 0.8, bbox: [10, 10, 30, 30] }],
  };
  const assistant = riverAssistant(task, riverResult(task));
  assert.equal(assistant.beforeResult, false);
  assert.equal(assistant.context.interpretation_mode, "result");
  assert.equal(assistant.context.include_image, true);
  assert.match(assistant.context.initial_question, /结合模型检测候选/);
});

test("unfinished or missing records never expose a result interpretation action", () => {
  for (const task of [null, {}, { id: "pending", status: "queued" }, { id: "pending", status: "running" }]) {
    assert.equal(riverAssistant(task, null), null);
  }
});

test("other AI modules retain an empty composer and drafts respect its length limit", () => {
  assert.equal(initialAssistantQuestion({ scope: "home" }), "");
  assert.equal(initialAssistantQuestion({ initial_question: null }), "");
  assert.equal(initialAssistantQuestion({ initial_question: "观".repeat(700) }).length, 500);
});
