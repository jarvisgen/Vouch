import React, { useEffect, useState } from "react";
import ReactDOM from "react-dom/client";
import { Providers } from "./providers";
import App from "./App";
import Landing from "./Landing";
import "./index.css";

// Tiny hash router: landing page at "#", dashboard at "#app".
function Root() {
  const [hash, setHash] = useState(window.location.hash);
  useEffect(() => {
    const on = () => setHash(window.location.hash);
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return hash === "#app" ? <App /> : <Landing />;
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <Providers>
      <Root />
    </Providers>
  </React.StrictMode>,
);
