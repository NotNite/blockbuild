const fs = require("fs");

async function main() {
  const host = fs.readFileSync("host_config.txt", "utf-8").trim();
  const requestedPath = process.argv[2];

  const hashes = await fetch(`${host}hashes.txt`).then((res) => res.text());
  for (const line of hashes.trim().split("\n")) {
    let [hash, path] = line.split("  ");
    // remove up to first slash
    path = path.replace(/^[^/]+\//, "");

    const filename = path.split("/").pop();
    const name = filename.replace(".jar", "");

    if (requestedPath === path) {
      console.log(
        `
name = "${name}"
filename = "${filename}"
side = "both"

[download]
url = "${host}${path}"
hash-format = "sha256"
hash = "${hash}"
`.trim()
      );
      return;
    }
  }
}

main();
