import React, { createContext, useContext, useEffect, useState, useCallback } from "react";

const THEME_KEY = "oaw_theme";
const THEMES = ["dark", "light"];
const SKIN_KEY = "oaw_skin";
const SKINS = [
  { id: "default", label: "默认（青绿）" },
  { id: "ocean", label: "海洋蓝" },
  { id: "forest", label: "森林绿" },
  { id: "sunset", label: "暖橙" },
  { id: "violet", label: "紫罗兰" },
];

const ThemeContext = createContext({ theme: "dark", setTheme: () => {}, skin: "default", setSkin: () => {} });

export function ThemeProvider({ children }) {
  const [theme, setThemeState] = useState(() => {
    try {
      const saved = localStorage.getItem(THEME_KEY);
      return THEMES.includes(saved) ? saved : "dark";
    } catch {
      return "dark";
    }
  });
  const [skin, setSkinState] = useState(() => {
    try {
      const saved = localStorage.getItem(SKIN_KEY);
      return SKINS.some((s) => s.id === saved) ? saved : "default";
    } catch {
      return "default";
    }
  });

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    try { localStorage.setItem(THEME_KEY, theme); } catch {}
  }, [theme]);

  useEffect(() => {
    document.documentElement.setAttribute("data-skin", skin);
    try { localStorage.setItem(SKIN_KEY, skin); } catch {}
  }, [skin]);

  const setTheme = useCallback((t) => {
    if (THEMES.includes(t)) setThemeState(t);
  }, []);

  const toggleTheme = useCallback(() => {
    setThemeState((t) => (t === "dark" ? "light" : "dark"));
  }, []);

  const setSkin = useCallback((s) => {
    if (SKINS.some((x) => x.id === s)) setSkinState(s);
  }, []);

  return (
    <ThemeContext.Provider value={{ theme, setTheme, toggleTheme, skin, setSkin }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  return useContext(ThemeContext);
}
export { SKINS };
