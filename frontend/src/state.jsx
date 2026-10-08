import React, {
  createContext,
  useContext,
  useEffect,
  useState,
  useCallback,
  useRef,
} from "react";
import { api } from "./lib/api";
import { preferenceStorage } from "./lib/privacy";
import { THEMES } from "./lib/themes";
const Auth = createContext(),
  Theme = createContext(),
  AI = createContext(),
  Toast = createContext();
export const useAuth = () => useContext(Auth),
  useTheme = () => useContext(Theme),
  useAI = () => useContext(AI),
  useToast = () => useContext(Toast);
export { THEMES } from "./lib/themes";
export function Providers({ children }) {
  const [user, setUser] = useState(null),
    [visitor, setVisitor] = useState(null),
    [loading, setLoading] = useState(true),
    [theme, setThemeState] = useState(() => {
      const id = preferenceStorage.getItem("hyhq.theme");
      return THEMES.some((t) => t.id === id) ? id : "forest";
    }),
    [context, setContext] = useState(null),
    [notice, setNotice] = useState("");
  const timer = useRef();
  const visitorRequest = useRef(null);
  const identityEpoch = useRef(0);
  const refresh = useCallback(async () => {
    const epoch = ++identityEpoch.current;
    try {
      const r = await api("me/");
      if (epoch === identityEpoch.current) setUser(r.data);
      return r.data;
    } catch (e) {
      if (e.status === 401 || e.status === 403) {
        if (epoch === identityEpoch.current) setUser(null);
        return null;
      }
      throw e;
    } finally {
      if (epoch === identityEpoch.current) setLoading(false);
    }
  }, []);
  useEffect(() => {
    refresh().catch(() => setLoading(false));
  }, [refresh]);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    preferenceStorage.setItem("hyhq.theme", theme);
  }, [theme]);
  const setTheme = (id) => {
    if (THEMES.some((t) => t.id === id)) setThemeState(id);
  };
  const ensureVisitor = useCallback(async () => {
    if (visitorRequest.current) return visitorRequest.current;
    const epoch = identityEpoch.current;
    visitorRequest.current = api("web/guest-session/", { method: "POST", data: {} })
      .then((r) => {
        if (epoch === identityEpoch.current && r.data?.auth_kind === "guest") setVisitor(r.data);
        return r.data;
      })
      .finally(() => { visitorRequest.current = null; });
    return visitorRequest.current;
  }, []);
  const login = async (email, password, agreement, altcha) => {
    identityEpoch.current++;
    setVisitor(null);
    await api("auth/login/", {
      method: "POST",
      data: { username: email, password, altcha, ...(agreement ? { agreement } : {}) },
    });
    return refresh();
  };
  const register = async ({
    email,
    username,
    password,
    nickname,
    agreement,
    altcha,
  }) => {
    identityEpoch.current++;
    setVisitor(null);
    await api("auth/register/", {
      method: "POST",
      data: {
        username: email || username,
        password,
        nickname,
        altcha,
        agreement:
          typeof agreement === "object"
            ? agreement
            : { accepted: agreement === true, version: "2026-10-07" },
      },
    });
    return refresh();
  };
  const logout = async () => {
    const epoch = ++identityEpoch.current;
    await api("auth/logout/", { method: "POST", data: {} });
    if (epoch === identityEpoch.current) {
      setUser(null);
      setVisitor(null);
      setContext(null);
      setLoading(false);
    }
  };
  const toast = useCallback((text) => {
    setNotice(text);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setNotice(""), 4200);
  }, []);
  return (
    <Auth.Provider value={{ user, visitor, ensureVisitor, loading, refresh, login, register, logout }}>
      <Theme.Provider value={{ theme, setTheme, themes: THEMES }}>
        <Toast.Provider value={toast}>
          <AI.Provider
            value={{ context, open: setContext, close: () => setContext(null) }}
          >
            {children}
            {notice && (
              <div className="toast" role="status">
                {notice}
              </div>
            )}
          </AI.Provider>
        </Toast.Provider>
      </Theme.Provider>
    </Auth.Provider>
  );
}
