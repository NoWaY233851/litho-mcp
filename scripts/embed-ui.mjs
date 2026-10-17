// Turns the single-file widget build into a TypeScript module so the function
// bundle carries it and can serve it without reading files at runtime.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

const html = readFileSync("dist/ui/app.html", "utf8");
mkdirSync("src/generated", { recursive: true });
writeFileSync("src/generated/app-html.ts", `export default ${JSON.stringify(html)};\n`);
