import assert from "node:assert/strict";
import test from "node:test";

import { MAX_NOTE_WORDS, countWords, paginateNotes, truncateToWords, type NoteRecord } from "../src/logic";

test("countWords handles whitespace correctly", () => {
  assert.equal(countWords("   hello   world\n\nthis\tis\ta\ttest  "), 6);
  assert.equal(countWords("   "), 0);
});

test("truncateToWords truncates above MAX_NOTE_WORDS", () => {
  const text = new Array(MAX_NOTE_WORDS + 5).fill("x").join(" ");
  const result = truncateToWords(text, MAX_NOTE_WORDS);

  assert.equal(result.wasTruncated, true);
  assert.equal(result.totalWords, MAX_NOTE_WORDS + 5);
  assert.equal(countWords(result.truncatedText), MAX_NOTE_WORDS);
});

test("hybrid pagination keeps day groups when possible and splits oversized days", () => {
  const mk = (id: number, createdAt: string): NoteRecord => ({
    id,
    content: `note-${id}`,
    word_count: 1,
    created_at: createdAt,
    updated_at: createdAt,
  });

  const notes: NoteRecord[] = [];

  for (let i = 1; i <= 12; i += 1) {
    notes.push(mk(i, `2026-02-24T12:${String(i).padStart(2, "0")}:00.000Z`));
  }

  for (let i = 13; i <= 18; i += 1) {
    notes.push(mk(i, `2026-02-23T11:${String(i).padStart(2, "0")}:00.000Z`));
  }

  const page1 = paginateNotes(notes, 1, 10);
  const page2 = paginateNotes(notes, 2, 10);

  assert.equal(page1.groups.length, 1);
  assert.equal(page1.groups[0].date_utc, "2026-02-24");
  assert.equal(page1.groups[0].notes.length, 10);

  assert.equal(page2.groups.length, 2);
  assert.equal(page2.groups[0].date_utc, "2026-02-24");
  assert.equal(page2.groups[0].notes.length, 2);
  assert.equal(page2.groups[1].date_utc, "2026-02-23");
  assert.equal(page2.groups[1].notes.length, 6);
});
