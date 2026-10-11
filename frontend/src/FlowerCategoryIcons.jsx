import React from "react";
import "./FlowerCategoryIcons.css";

const FLOWER_CATEGORIES = [
  { kind: "daisy", label: "雏菊类" },
  { kind: "tulips", label: "郁金香类" },
  { kind: "dandelion", label: "蒲公英类" },
  { kind: "roses", label: "蔷薇属" },
  { kind: "sunflowers", label: "向日葵类" },
];

function FlowerCategoryIcon({ kind }) {
  return (
    <svg
      className="flower-category-icon"
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.55"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {kind === "daisy" && (
        <>
          <path d="M12 14v8m0-3c-3 0-4.5-1.5-5-4 3 0 4.5 1.5 5 4Z" />
          {[0, 45, 90, 135, 180, 225, 270, 315].map((angle) => (
            <ellipse
              key={angle}
              cx="12"
              cy="4.8"
              rx="1.45"
              ry="2.8"
              transform={`rotate(${angle} 12 9.2)`}
            />
          ))}
          <circle cx="12" cy="9.2" r="1.9" />
        </>
      )}
      {kind === "tulips" && (
        <>
          <path d="M6 3 9.5 6 12 2l2.5 4L18 3v5a6 6 0 0 1-12 0V3Z" />
          <path d="M12 14v8m0-2c-4 0-6.5-2.5-7-6 4 0 6.5 2.5 7 6Zm0 1c4 0 6.5-2.5 7-6-4 0-6.5 2.5-7 6Z" />
        </>
      )}
      {kind === "dandelion" && (
        <>
          <path d="M12 11v11m0-4 4-2" />
          {[0, 45, 90, 135, 180, 225, 270, 315].map((angle) => (
            <path
              key={angle}
              d="M12 8V2m-1.6 1.7L12 2l1.6 1.7"
              transform={`rotate(${angle} 12 9)`}
            />
          ))}
          <circle cx="12" cy="9" r="1.2" />
          <path d="m18.5 3.5 2-1m-1.2-.5 1.2.5-.3 1.3" />
        </>
      )}
      {kind === "roses" && (
        <>
          <path d="M12 14v8m0-4c-3.5 0-5.5-1.5-6-4 3.5 0 5.5 1.5 6 4Zm0 3c3.5 0 5.5-1.5 6-4-3.5 0-5.5 1.5-6 4Z" />
          <path d="M12 2.5c2-1 4 .2 4.3 2.1 2.2.4 3.2 2.7 1.9 4.5.3 2.5-1.7 4.6-4 4.1-1.8 1.5-4.7 1.3-5.7-.6-2.6-.2-4-2.8-2.7-4.7-1-2.1.5-4.3 2.8-4.2.8-1.7 2.2-2 3.4-1.2Z" />
          <path d="M8.5 7c.5-2 4-3 5.8-.8 2 2.4-.1 5.1-2.8 4.5-2.5-.6-2.7-3.9-.3-4.2 1.1-.2 1.9.7 1.3 1.5" />
        </>
      )}
      {kind === "sunflowers" && (
        <>
          <path d="M12 15v7m0-3c3 0 4.5-1.5 5-4-3 0-4.5 1.5-5 4Z" />
          <path d="m12 1 2 3 3.7-.7-.1 3.5L21 9l-3.4 2.2.1 3.5-3.7-.7-2 3-2-3-3.7.7.1-3.5L3 9l3.4-2.2-.1-3.5L10 4l2-3Z" />
          <circle cx="12" cy="9" r="3.2" />
          <path d="M11 8.1h.01m1.98 0H13m-1.01 2.1H12" />
        </>
      )}
    </svg>
  );
}

export function FlowerCategoryLabels() {
  return (
    <div className="p-flower-labels p-flower-category-labels">
      {FLOWER_CATEGORIES.map(({ kind, label }) => (
        <span key={kind}>
          <FlowerCategoryIcon kind={kind} />
          <span>{label}</span>
        </span>
      ))}
    </div>
  );
}
