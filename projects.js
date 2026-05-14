(() => {
  const isHttpPage = /^https?:$/i.test(window.location.protocol || "");
  const apiBaseUrl = isHttpPage
    ? window.location.origin
    : "http://127.0.0.1:4321";

  window.DASHBOARD_CONFIG = {
    workspaceRoot: "E:/Project/codex",
    apiBaseUrl
  };
})();
