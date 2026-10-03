// Compiles contracts/ with solc-js and writes artifacts/<Contract>.json (abi + bytecode).
const fs = require("fs");
const path = require("path");
const solc = require("solc");

const root = path.join(__dirname, "..");
const sources = {};
function walk(dir) {
  for (const f of fs.readdirSync(dir)) {
    const p = path.join(dir, f);
    if (fs.statSync(p).isDirectory()) walk(p);
    else if (f.endsWith(".sol")) sources[path.relative(root, p)] = { content: fs.readFileSync(p, "utf8") };
  }
}
walk(path.join(root, "contracts"));

const input = {
  language: "Solidity",
  sources,
  settings: {
    optimizer: { enabled: true, runs: 200 },
    evmVersion: "shanghai",
    outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } },
  },
};

const findImports = (p) => {
  for (const base of [root, path.join(root, "node_modules")]) {
    const full = path.join(base, p);
    if (fs.existsSync(full)) return { contents: fs.readFileSync(full, "utf8") };
  }
  return { error: "not found: " + p };
};

const out = JSON.parse(solc.compile(JSON.stringify(input), { import: findImports }));
const errors = (out.errors || []).filter((e) => e.severity === "error");
for (const e of out.errors || []) if (e.severity === "error" || process.env.WARN) console.error(e.formattedMessage);
if (errors.length) process.exit(1);

const dir = path.join(root, "artifacts");
fs.mkdirSync(dir, { recursive: true });
for (const file of Object.keys(out.contracts)) {
  if (!file.startsWith("contracts")) continue;
  for (const [name, c] of Object.entries(out.contracts[file])) {
    fs.writeFileSync(
      path.join(dir, name + ".json"),
      JSON.stringify({ abi: c.abi, bytecode: "0x" + c.evm.bytecode.object }, null, 2)
    );
  }
}
console.log("Compilation OK ->", dir);

// Files generated for the web page: the factory to deploy from the wallet, and the
// winnings computation logic (the same as the keeper's).
const web = path.join(root, "docs");
const fa = JSON.parse(fs.readFileSync(path.join(dir, "P33LotteryVaultFactory.json"), "utf8"));
fs.writeFileSync(path.join(web, "factory.js"), "window.FACTORY_ARTIFACT = " + JSON.stringify({ abi: fa.abi, bytecode: fa.bytecode }) + ";\n");
require("esbuild").buildSync({
  entryPoints: [path.join(root, "keeper", "lib.js")],
  bundle: true, minify: true, format: "iife", globalName: "VaultLib", platform: "browser", target: "es2020",
  outfile: path.join(web, "vaultlib.js"),
});
console.log("Web page: factory.js and vaultlib.js generated");
