// Tiny zero-dependency static file server for local preview of docs/.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "docs");
const PORT = process.env.PORT || 8080;

const TYPES = {
	".html": "text/html; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".js": "application/javascript; charset=utf-8",
	".json": "application/json; charset=utf-8",
};

http
	.createServer((req, res) => {
		let urlPath = decodeURIComponent(req.url.split("?")[0]);
		if (urlPath.endsWith("/")) urlPath += "index.html";
		let filePath = path.join(ROOT, urlPath);
		if (!filePath.startsWith(ROOT)) {
			res.writeHead(403);
			res.end("Forbidden");
			return;
		}
		fs.readFile(filePath, (err, data) => {
			if (err) {
				res.writeHead(404, { "content-type": "text/plain" });
				res.end("404 Not Found: " + urlPath);
				return;
			}
			res.writeHead(200, { "content-type": TYPES[path.extname(filePath)] || "application/octet-stream" });
			res.end(data);
		});
	})
	.listen(PORT, () => console.log(`Serving docs/ at http://localhost:${PORT}/`));
