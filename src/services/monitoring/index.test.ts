import { describe, expect, it } from "vitest";
import { assignKode, buildTaskforceCsv, monitoringFilename, shouldSkipQuery, TASKFORCE_COLUMNS, wilayahKey } from ".";

function parseCsv(csv: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  const text = csv.replace(/^\uFEFF/, "");
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (char === '"') quoted = false;
      else field += char;
    } else if (char === '"') quoted = true;
    else if (char === ",") { row.push(field); field = ""; }
    else if (char === "\r") continue;
    else if (char === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else field += char;
  }
  return rows;
}

describe("wilayahKey", () => {
  it("prefers level 2 and is order independent", () => {
    expect(wilayahKey({ level1: ["97"], level2: ["9706", "9702"] })).toBe("L2:9702|9706");
    expect(wilayahKey({ level1: ["97"], level2: [] })).toBe("L1:97");
    expect(wilayahKey({ level1: [], level2: [] })).toBe("ALL");
  });
});

describe("shouldSkipQuery", () => {
  it("skips only completed, unchanged SQL that never produced records", () => {
    expect(shouldSkipQuery(undefined, "a")).toBe(false);
    expect(shouldSkipQuery({ sqlHash: "a", completeRuns: 1, everRows: false }, "a")).toBe(true);
    expect(shouldSkipQuery({ sqlHash: "a", completeRuns: 2, everRows: true }, "a")).toBe(false);
    expect(shouldSkipQuery({ sqlHash: "a", completeRuns: 0, everRows: false }, "a")).toBe(false);
    expect(shouldSkipQuery({ sqlHash: "old", completeRuns: 3, everRows: false }, "new")).toBe(false);
  });
});

describe("assignKode", () => {
  it("keeps existing codes and fills gaps from the start number", () => {
    const result = assignKode({ "A/q2.sql": 11 }, ["A/q1.sql", "A/q2.sql", "A/q3.sql"], 10);
    expect(result).toEqual({ "A/q1.sql": 10, "A/q2.sql": 11, "A/q3.sql": 12 });
  });
});

describe("buildTaskforceCsv", () => {
  const columns = ["assignment_id", "index1", "level_6_full_code", "level_6_name", "nama_usaha", "kbli_akhir", "produk"];

  it("maps query columns to the monitoring taskforce header", () => {
    const result = buildTaskforceCsv({
      kode: 12,
      title: "Konsistensi KBLI 01116",
      columns,
      rows: [["aid-1", "1002", "9706040002000100", "SLS A", "USAHA, \"KACANG\"", "01116", "KACANG TANAH"]],
      completedAt: "2026-10-13T08:00:00.000Z",
    });
    const [header, row] = parseCsv(result.csv);
    expect(header).toEqual([...TASKFORCE_COLUMNS, "kbli_akhir", "produk"]);
    expect(row).toEqual([
      "T12", "Konsistensi KBLI 01116", "aid-1", "9706040002000100", "SLS A",
      "USAHA, \"KACANG\"", "1002", "", "", "", "2026-10-13T08:00:00.000Z", "01116", "KACANG TANAH",
    ]);
    expect(result.exportedRows).toBe(1);
    expect(result.mapping.kode_sls).toBe("level_6_full_code");
  });

  it("drops rows the importer would reject and reports them", () => {
    const result = buildTaskforceCsv({
      kode: 10,
      title: "x",
      columns: ["assignment_id", "level_4_full_code", "nama_usaha"],
      rows: [["aid-1", "9706040002", "A"], ["", "9706040002", "B"]],
      completedAt: "t",
    });
    expect(result.exportedRows).toBe(0);
    expect(result.skippedNoSls).toBe(1);
    expect(result.skippedNoId).toBe(1);
    expect(result.mapping.kode_sls).toBeUndefined();
    expect(parseCsv(result.csv)).toHaveLength(1);
  });

  it("matches source columns case-insensitively and keeps unrelated columns as detail", () => {
    const result = buildTaskforceCsv({
      kode: 10,
      title: "x",
      columns: ["Assignment_ID", "KODE_SLS", "Status", "selisih"],
      rows: [["a", "9702160010000600", "SUBMITTED BY Pencacah", 12.5]],
      completedAt: "t",
    });
    const [header, row] = parseCsv(result.csv);
    expect(header?.at(-1)).toBe("selisih");
    expect(row?.[7]).toBe("SUBMITTED BY Pencacah");
    expect(row?.at(-1)).toBe("12.5");
  });
});

it("builds a safe CSV filename", () => {
  expect(monitoringFilename(12, "Tabel Mikro: KBLI 01116 / Kacang")).toBe("T12_Tabel_Mikro_KBLI_01116_Kacang.csv");
});
