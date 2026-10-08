import React, { useState } from "react";
import { Link } from "react-router-dom";
import { Cookie, ShieldCheck } from "lucide-react";
import { Modal } from "./components";
import { privacyChoice, savePrivacyChoice } from "./lib/privacy";
export default function PrivacyControls() {
  const [choice, setChoice] = useState(privacyChoice),
    [open, setOpen] = useState(false);
  const [preferences, setPreferences] = useState(
    privacyChoice()?.preferences === true,
  );
  function showSettings() {
    setPreferences(privacyChoice()?.preferences === true);
    setOpen(true);
  }
  function save(value) {
    setChoice(savePrivacyChoice(value));
    setPreferences(value);
    setOpen(false);
  }
  return (
    <>
      <button className="privacy-settings-link" onClick={showSettings}>
        <Cookie size={14} />
        Cookie 与存储设置
      </button>
      {!choice && (
        <aside className="cookie-banner" aria-label="Cookie 与浏览器存储选择">
          <Cookie size={23} />
          <div>
            <strong>关于 Cookie 与本机存储</strong>
            <p>
              必要 Cookie
              用于登录、游客记录隔离和防刷。允许偏好后可记住主题与城市；本站不使用广告或追踪
              Cookie。<Link to="/legal/privacy">了解详情</Link>
            </p>
          </div>
          <div className="cookie-actions">
            <button className="btn secondary" onClick={() => save(false)}>
              仅必要
            </button>
            <button className="btn secondary" onClick={showSettings}>
              设置
            </button>
            <button className="btn" onClick={() => save(true)}>
              允许偏好
            </button>
          </div>
        </aside>
      )}
      {open && (
        <Modal title="Cookie 与存储设置" onClose={() => setOpen(false)}>
          <div className="privacy-option">
            <ShieldCheck size={20} />
            <div>
              <strong>必要功能 · 始终启用</strong>
              <p>
                登录与游客会话、验证码、防刷限额、天气缓存和本次隐私选择。它们用于提供你主动使用的服务；不用于广告画像。
              </p>
            </div>
          </div>
          <label className="privacy-option">
            <input
              type="checkbox"
              checked={preferences}
              onChange={(e) => setPreferences(e.target.checked)}
            />
            <div>
              <strong>记住我的偏好</strong>
              <p>
                将主题和天气／导览城市保存在此浏览器。关闭后仍可切换，但不再跨浏览器会话记住选择。
              </p>
            </div>
          </label>
          <p className="muted">
            无分析或营销 Cookie。底图和 AI 等外部服务的说明见{" "}
            <Link to="/legal/privacy" onClick={() => setOpen(false)}>
              隐私政策
            </Link>
            ；拒绝偏好不会退出账号，也不会删除服务端私人记录。
          </p>
          <div className="cookie-actions">
            <button className="btn secondary" onClick={() => save(false)}>
              仅必要
            </button>
            <button className="btn" onClick={() => save(preferences)}>
              保存选择
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}
