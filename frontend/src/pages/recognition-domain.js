/** Prepare an editable question only; opening the assistant never sends a turn. */
export function riverAssistant(task, result) {
  if (!task?.id || !["succeeded", "failed"].includes(task.status)) return null;
  const inconclusive = !result?.detections?.length;
  const outcome =
    task.status === "failed"
      ? "本次检测未完成。"
      : inconclusive
        ? "模型本次未检出可展示的漂浮物候选。"
        : "请结合模型检测候选，说明哪些可见细节值得进一步核对。";
  return {
    beforeResult: inconclusive,
    context: {
      scope: "recognition",
      assessment_job_id: task.id,
      interpretation_mode: inconclusive ? "image" : "result",
      include_image: true,
      initial_question:
        "请结合这张河道原图，描述水面与岸边可见的物体、可能的漂浮物和观察盲区。" +
        outcome +
        "请说明不确定之处，不要把未检出理解为没有污染，也不要仅凭照片判断真实水质。",
    },
  };
}

export function initialAssistantQuestion(context) {
  return typeof context?.initial_question === "string"
    ? context.initial_question.slice(0, 500)
    : "";
}
