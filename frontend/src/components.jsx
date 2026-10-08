import React, { useEffect, useRef } from "react";
import { marked } from "marked";
import DOMPurify from "dompurify";
import { X, Sparkles, Leaf, ArrowRight } from "lucide-react";
import { useAI } from "./state";
export function PageHeader({ eyebrow, title, children }) {
  return (
    <header className="page-header">
      <div>
        {eyebrow && <div className="eyebrow">{eyebrow}</div>}
        <h1>{title}</h1>
      </div>
      {children && <div className="page-header-actions">{children}</div>}
    </header>
  );
}
export function State({ loading, error, empty, onRetry, children }) {
  if (loading)
    return (
      <div className="state" role="status">
        <Leaf className="loading-leaf" />
        <p>正在加载</p>
      </div>
    );
  if (error)
    return (
      <div className="state" role="alert">
        <p>{error.message || String(error)}</p>
        {onRetry && (
          <button className="btn secondary" onClick={onRetry}>
            重新加载
          </button>
        )}
      </div>
    );
  if (empty)
    return (
      <div className="state empty-state">
        <Leaf />
        <p>{typeof empty === "string" ? empty : "暂时没有内容"}</p>
      </div>
    );
  return children;
}
export function Markdown({ text = "" }) {
  const html = DOMPurify.sanitize(
    marked.parse(String(text), { breaks: true, gfm: true }),
    {
      FORBID_TAGS: ["style", "iframe", "form", "input", "video"],
      FORBID_ATTR: ["style"],
      ADD_ATTR: ["target"],
    },
  );
  return (
    <div className="markdown" dangerouslySetInnerHTML={{ __html: html }} />
  );
}
export function Modal({ title, onClose, children, className = "" }) {
  const ref = useRef();
  useEffect(() => {
    const prior = document.activeElement;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e) => {
      if (e.key === "Escape") onClose();
      if (e.key === "Tab") {
        const items = ref.current?.querySelectorAll(
          'button:not([disabled]),a[href],input:not([disabled]),textarea:not([disabled]),select:not([disabled]),[tabindex="0"]',
        );
        if (!items?.length) return;
        const first = items[0],
          last = items[items.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", onKey);
    ref.current?.querySelector("textarea,input,button")?.focus();
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", onKey);
      prior?.focus?.();
    };
  }, []);
  return (
    <div
      className="modal-shade"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <section
        ref={ref}
        className={"modal " + className}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <header className="modal-header">
          <h2>{title}</h2>
          <button className="icon-btn" onClick={onClose} aria-label="关闭">
            <X />
          </button>
        </header>
        {children}
      </section>
    </div>
  );
}
export function AIButton({
  context,
  label = "问问 AI",
  className = "",
  floating = false,
}) {
  const { open } = useAI();
  return (
    <button
      className={
        "btn ai-button " + (floating ? "floating-ai " : "") + className
      }
      onClick={() => open(typeof context === "function" ? context() : context)}
    >
      <Sparkles size={19} />
      <span>{label}</span>
    </button>
  );
}
export function SectionTitle({ title, children }) {
  return (
    <div className="section-title">
      <h2>{title}</h2>
      {children}
    </div>
  );
}
export function TextLink({ children, ...props }) {
  return (
    <a className="text-link" {...props}>
      {children}
      <ArrowRight size={16} />
    </a>
  );
}
