"use strict";
const fs = require("node:fs/promises");
const path = require("node:path");
function localCloud(root) {
  const base = path.resolve(root);
  function resolve(id) {
    if (
      typeof id !== "string" ||
      !/^hyhq-private\/[a-f0-9-]{36}\/[a-f0-9-]{36}\/(original|thumbnail)\.jpg$/.test(
        id,
      )
    )
      throw new Error("Invalid private file");
    const filename = path.resolve(base, id);
    if (!filename.startsWith(base + path.sep)) throw new Error("Invalid path");
    return filename;
  }
  return {
    async uploadFile({ cloudPath, fileContent }) {
      const filename = resolve(cloudPath);
      await fs.mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
      await fs.writeFile(filename, fileContent, { mode: 0o600, flag: "wx" });
      return { fileID: cloudPath };
    },
    async downloadFile({ fileID }) {
      return { fileContent: await fs.readFile(resolve(fileID)) };
    },
    async deleteFile({ fileList }) {
      const result = [];
      for (const fileID of fileList) {
        await fs.rm(resolve(fileID), { force: true });
        result.push({ fileID, status: 0 });
      }
      return { fileList: result };
    },
  };
}
module.exports = { localCloud };
