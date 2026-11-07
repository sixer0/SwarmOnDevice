/**
 * Row 110: fail-closed stand-in for `lucide-react`, loaded only by `bun --preload` for the build-time template
 * export. `vendor/src/lib/studio/contract/ui.ts:5` imports React icons; the export never renders UI, so every
 * icon here throws if used. Same mechanism as the C12 probe stub. Remove once the contract/ui.ts twin without
 * the lucide-react import (studio spec 1.3) exists.
 */
import { plugin } from "bun";

plugin({
  name: "row110-lucide-react-fail-closed",
  setup(build) {
    build.module("lucide-react", () => {
      const icon = (name: string) => () => {
        throw new Error(`lucide-react ${name} is not available in the template export`);
      };
      const names = ["Activity", "FilePlus2", "FileStack", "FileText", "FlaskConical", "LayoutTemplate", "Shapes"];
      return { exports: Object.fromEntries(names.map((n) => [n, icon(n)])), loader: "object" };
    });
  },
});
