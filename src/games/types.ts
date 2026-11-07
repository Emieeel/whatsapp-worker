export interface ParsedScore {
  score: number;
  maxScore: number;
  /**
   * Identifier of the puzzle, e.g. the puzzle number. If the same puzzle already showed
   * up on an earlier day, the result is treated as a re-post and ignored.
   */
  puzzle?: string;
  /**
   * Calendar date printed in the result (games that print a date instead of a number).
   * The result only counts if this matches the day the message was sent.
   */
  puzzleDate?: { month: number; day: number };
}

export interface GameParser {
  /** Stable id, stored in the database. Never change it once scores exist. */
  id: string;
  /** Display name used in leaderboards. */
  name: string;
  emoji: string;
  /** Maximum attainable score; used to normalise scores for the combined ranking. */
  maxScore: number;
  /** Return the score if `text` is a result for this game, otherwise null. */
  parse(text: string): ParsedScore | null;
}
