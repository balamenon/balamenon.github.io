export const MAX_NOTE_WORDS = 10000;

export type NoteRecord = {
  id: number;
  content: string;
  word_count: number;
  created_at: string;
  updated_at: string;
};

export type NotesDayGroup = {
  date_utc: string;
  notes: NoteRecord[];
};

export type NotesPage = {
  page: number;
  page_size: number;
  has_next: boolean;
  has_prev: boolean;
  total_pages: number;
  groups: NotesDayGroup[];
};

export function countWords(text: string): number {
  const normalized = text.trim();
  if (!normalized) {
    return 0;
  }
  return normalized.split(/\s+/).length;
}

export function truncateToWords(text: string, maxWords: number): { truncatedText: string; wasTruncated: boolean; totalWords: number } {
  const words = text.trim().split(/\s+/).filter(Boolean);
  const totalWords = words.length;
  if (totalWords <= maxWords) {
    return {
      truncatedText: text,
      wasTruncated: false,
      totalWords,
    };
  }

  return {
    truncatedText: words.slice(0, maxWords).join(" "),
    wasTruncated: true,
    totalWords,
  };
}

function groupByDay(notes: NoteRecord[]): NotesDayGroup[] {
  const map = new Map<string, NoteRecord[]>();
  for (const note of notes) {
    const day = note.created_at.slice(0, 10);
    const existing = map.get(day);
    if (existing) {
      existing.push(note);
    } else {
      map.set(day, [note]);
    }
  }

  return Array.from(map.entries()).map(([date_utc, dayNotes]) => ({
    date_utc,
    notes: dayNotes,
  }));
}

function pushGroupChunk(target: NotesDayGroup[], date_utc: string, chunk: NoteRecord[]): void {
  if (!chunk.length) {
    return;
  }
  const last = target.at(-1);
  if (last && last.date_utc === date_utc) {
    last.notes.push(...chunk);
    return;
  }
  target.push({ date_utc, notes: [...chunk] });
}

function buildHybridPages(groups: NotesDayGroup[], pageSize: number): NotesDayGroup[][] {
  const pages: NotesDayGroup[][] = [];

  let currentPage: NotesDayGroup[] = [];
  let currentCount = 0;

  const flushPage = () => {
    if (!currentPage.length) {
      return;
    }
    pages.push(currentPage);
    currentPage = [];
    currentCount = 0;
  };

  for (const group of groups) {
    const groupCount = group.notes.length;

    if (groupCount <= pageSize) {
      if (currentCount === 0 || currentCount + groupCount <= pageSize) {
        currentPage.push({ date_utc: group.date_utc, notes: [...group.notes] });
        currentCount += groupCount;
      } else {
        flushPage();
        currentPage.push({ date_utc: group.date_utc, notes: [...group.notes] });
        currentCount = groupCount;
      }
      continue;
    }

    let cursor = 0;
    while (cursor < groupCount) {
      let remaining = pageSize - currentCount;
      if (remaining === 0) {
        flushPage();
        remaining = pageSize;
      }

      const chunkSize = Math.min(remaining, groupCount - cursor);
      const chunk = group.notes.slice(cursor, cursor + chunkSize);
      pushGroupChunk(currentPage, group.date_utc, chunk);
      currentCount += chunkSize;
      cursor += chunkSize;

      if (currentCount === pageSize) {
        flushPage();
      }
    }
  }

  flushPage();
  return pages;
}

export function paginateNotes(notes: NoteRecord[], page: number, pageSize: number): NotesPage {
  const safePageSize = Math.max(1, Math.min(pageSize, 10));
  const safePage = Math.max(1, page);

  const groups = groupByDay(notes);
  const pages = buildHybridPages(groups, safePageSize);

  const totalPages = pages.length;
  const pageGroups = pages[safePage - 1] ?? [];

  return {
    page: safePage,
    page_size: safePageSize,
    has_next: safePage < totalPages,
    has_prev: safePage > 1 && totalPages > 0,
    total_pages: totalPages,
    groups: pageGroups,
  };
}

export function previewText(text: string, maxWords = 80): string {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length <= maxWords) {
    return words.join(" ");
  }
  return `${words.slice(0, maxWords).join(" ")} ...`;
}
