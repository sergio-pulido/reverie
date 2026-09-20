import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";
import "./shell/shell.css";
import "./discover/discover.css";
import "./search/search.css";
import "./home/home.css";
import "./catalog/catalog.css";
import "./about/about.css";
import "./create/create.css";

import "./director/director.css";

createRoot(document.getElementById("root")!).render(<App />);
