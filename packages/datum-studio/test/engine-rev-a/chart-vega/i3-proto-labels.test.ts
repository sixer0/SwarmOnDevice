// I-3 (C164 L8): the label "__proto__" (and "constructor") as a data VALUE renders like any other label.
import { expect, test } from "bun:test";
import { renderVegaChart } from "../../../vendor/src/lib/studio/engine/chart/family-v/index";
import { FIXTURES } from "./fixtures";

const clone = (x: unknown) => structuredClone(x) as any;
const protoNames = () => [Object.getOwnPropertyNames(Object.prototype).join(","), Object.getOwnPropertyNames(Array.prototype).join(",")];

for (const word of ["__proto__", "constructor"]) {
  test(`V-02 category "${word}" renders with every label`, async () => {
    const before = protoNames();
    const s = clone(FIXTURES["V-02"]);
    delete s.accent;
    s.data.categories[0] = word;
    const r = await renderVegaChart(s);
    expect(r.svg).toContain(`>${word}<`);
    expect(r.svg).not.toContain("⁣");
    for (const c of s.data.categories.slice(1)) expect(r.svg).toContain(c);
    expect(protoNames()).toEqual(before);
    expect(({} as any).polluted).toBeUndefined();
  });
  test(`V-02 series "${word}" renders`, async () => {
    const s = clone(FIXTURES["V-02"]);
    delete s.accent;
    s.data.series[0].name = word;
    const r = await renderVegaChart(s);
    expect(r.svg).toContain(`>${word}<`);
  });
  test(`V-03 row and column "${word}" render with every label and the row name`, async () => {
    const before = protoNames();
    const base = clone(FIXTURES["V-03"]);
    delete base.accent;
    const plain = await renderVegaChart(base);
    const s = clone(base);
    s.data.rows[0] = word;
    s.data.cols[0] = word;
    const r = await renderVegaChart(s);
    expect((r.svg.match(/<text/g) ?? []).length).toBe((plain.svg.match(/<text/g) ?? []).length);
    expect(r.svg).toContain(`>${word}<`);
    expect(r.svg).not.toContain("⁣");
    expect(protoNames()).toEqual(before);
  });
  test(`V-03 accent row "${word}" is named at the line end`, async () => {
    const s = clone(FIXTURES["V-03"]);
    s.data.rows[0] = word;
    s.accent = { point: word };
    const r = await renderVegaChart(s);
    expect(r.svg).toContain(`>${word}<`);
  });
}
