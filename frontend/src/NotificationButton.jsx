import React, { useEffect, useSyncExternalStore } from "react";
import { Link, useLocation } from "react-router-dom";
import { Bell, Palette } from "lucide-react";
import { useAuth } from "./state";
import { api } from "./lib/api";
import { createUnreadStore } from "./lib/notification-unread";
import "./NotificationButton.css";

const unreadStore = createUnreadStore(async (signal) => {
  const response = await api("web/notifications/", {
    data: { read: false, page_size: 1 },
    signal,
  });
  return response.data?.length > 0;
});

// Call only after a notification has successfully been read or deleted.
export function notifyNotificationsChanged() {
  return unreadStore.refresh({ force: true });
}

export default function NotificationButton({ desktop = false }) {
  const { user, loading } = useAuth();
  const { pathname } = useLocation();
  const state = useSyncExternalStore(
    unreadStore.subscribe,
    unreadStore.getSnapshot,
  );
  const owner = loading ? "" : user?.id || "";
  const unread = !!owner && state.owner === owner && state.unread;

  useEffect(() => {
    unreadStore.setOwner(owner);
    if (!owner) return;
    const refresh = () => {
      if (document.visibilityState !== "hidden") unreadStore.refresh();
    };
    refresh();
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    const timer = window.setInterval(refresh, 60000);
    return () => {
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
      window.clearInterval(timer);
    };
  }, [owner]);
  useEffect(() => {
    if (owner) unreadStore.refresh();
  }, [pathname, owner]);

  return (
    <div
      className={`header-quick-actions ${desktop ? "header-quick-actions-desktop" : "header-quick-actions-page"}`}
    >
      <Link
        className="icon-btn theme-button"
        aria-label="切换主题"
        title="切换主题"
        to="/themes"
      >
        <Palette size={desktop ? 19 : 21} aria-hidden="true" />
      </Link>
      <Link
        className={`icon-btn notification-button ${desktop ? "notification-button-desktop" : "notification-button-page"}`}
        aria-label={unread ? "通知中心，有未读消息" : "通知中心"}
        title={unread ? "通知中心，有未读消息" : "通知中心"}
        to="/notifications"
      >
        <Bell size={desktop ? 19 : 21} aria-hidden="true" />
        {unread && (
          <span className="notification-unread-dot" aria-hidden="true" />
        )}
      </Link>
    </div>
  );
}
