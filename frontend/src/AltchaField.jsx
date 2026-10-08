import React, { useEffect, useRef } from "react";
import "altcha/external";
import "altcha/altcha.css";
import "altcha/i18n/zh-cn";
import Pbkdf2Worker from "altcha/workers/pbkdf2?worker";
import "./AltchaField.css";

// Vite emits a same-origin worker file. No CAPTCHA cloud service or CDN is used.
globalThis.$altcha.algorithms.set("PBKDF2/SHA-256", () => new Pbkdf2Worker());

export default function AltchaField({ purpose, onChange, disabled = false }) {
  const ref = useRef(null);
  useEffect(() => {
    const widget = ref.current;
    onChange("");
    const verified = (event) =>
      onChange(
        typeof event.detail?.payload === "string" ? event.detail.payload : "",
      );
    const stateChanged = (event) => {
      if (event.detail?.state !== "verified") onChange("");
    };
    widget.addEventListener("verified", verified);
    widget.addEventListener("statechange", stateChanged);
    return () => {
      widget.removeEventListener("verified", verified);
      widget.removeEventListener("statechange", stateChanged);
    };
  }, [purpose, onChange]);
  return (
    <div
      className="altcha-field"
      aria-label="防刷验证"
      aria-disabled={disabled}
      inert={disabled ? true : undefined}
    >
      <altcha-widget
        ref={ref}
        challenge={`/api/v1/web/captcha/?purpose=${purpose}`}
        auto="off"
        type="checkbox"
        language="zh-cn"
        name="altcha"
        configuration='{"workers":2,"humanInteractionSignature":false}'
      />
    </div>
  );
}
