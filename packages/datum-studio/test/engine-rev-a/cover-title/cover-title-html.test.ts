// Row 122c (Swarm 1.2.0, decision C96 O1): HTML cover title leading follows the manual and equals DOCX. Manual Rev A
// ID p.47 butir 7 and p.90 Tabel A.2: title 24-26 pt Cond 600, no leading given; the manual's own cover (ID p.1)
// sets 24 pt title lines 28 pt apart. One rule for both engines (formats.ts coverTitleLineTw = size + 4 pt).
// Before: HTML raised the leading to the Plex Cond line box (24 pt -> 31.7 pt) while DOCX printed 29 pt.
import { describe, expect, test } from "bun:test";
import { renderHtml } from "../html/_kit";

const titleStyles = (cover: string) =>
  [...cover.matchAll(/<span\b[^>]*data-role="cover\.title(?:First|Last)"[^>]*>/g)].map((m) => {
    const st = /style="([^"]*)"/.exec(m[0])?.[1] ?? "";
    return [/font-size:([0-9.]+)pt/.exec(st)?.[1], /line-height:([0-9.]+)pt/.exec(st)?.[1]];
  });

describe("cover title leading, HTML (Manual Rev A ID p.1 cover, p.47 butir 7, p.90 Tabel A.2)", () => {
  test("24 pt title on 28 pt (manual, same as DOCX w:line 560), 26 pt on 30 pt", async () => {
    expect(titleStyles((await renderHtml()).unit("cover"))).toEqual([["24", "28"], ["24", "28"]]);
    expect(titleStyles((await renderHtml(undefined, { "cover.title.sizePt": 26 })).unit("cover"))).toEqual([["26", "30"], ["26", "30"]]);
  });
});
