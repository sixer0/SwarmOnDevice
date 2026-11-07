// Row 107 M5 probe (not a test file): imports one vendored entry module in a fresh process with
// stdin open and no argv. If importing ran main(), the stdio MCP server would log "started" and the
// CLIs would print usage / exit non-zero. `module` is also exposed as require.main, the condition
// a single-file bundle creates for code inlined into the entry chunk.
const icon = () => null;
Bun.plugin({
  name: "row107-ui-stub",
  setup(build) {
    build.module("lucide-react", () => ({
      loader: "object",
      exports: { Activity: icon, FilePlus2: icon, FileStack: icon, FileText: icon, FlaskConical: icon, LayoutTemplate: icon, Shapes: icon },
    }));
  },
});
(globalThis as { module?: unknown }).module = require.main;
await import(process.argv[2]);
process.stdout.write("IMPORTED\n");
setTimeout(() => process.exit(0), 500);
