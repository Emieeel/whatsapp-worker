import { describe, expect, it } from 'vitest';
import { parseScores } from '../src/games/index.js';
import { maptap } from '../src/games/maptap.js';
import { polderprikker } from '../src/games/polderprikker.js';

describe('Polderprikker', () => {
  it('parses the canonical share text', () => {
    const text = '#Polderprikker nummer 158 • 4478/5000\n🟦1000 🟦1000 🟩995 🟧504 🟩979\nhttps://polderprikker.nl/';
    expect(polderprikker.parse(text)).toEqual({ score: 4478, maxScore: 5000, puzzle: '158' });
  });

  it.each([
    ['no hash, "nr." and a dash', 'Polderprikker nr. 159 - 3990/5000', 3990, '159'],
    ['thousands separators', '#Polderprikker nummer 160 • 2.345/5.000', 2345, '160'],
    ['no spaces, spaces around slash', '#Polderprikker nummer 161•4999 / 5000', 4999, '161'],
    ['non-breaking spaces', '#Polderprikker nummer 162 • 4478/5000', 4478, '162'],
    ['line break before the score', '#Polderprikker nummer 163\n4478/5000\n🟦1000', 4478, '163'],
    ['chat text around it', 'pfff slecht vandaag\n#POLDERPRIKKER nummer 164 • 812/5000\n🟥0 🟥0', 812, '164'],
    ['zero score', '#Polderprikker nummer 165 • 0/5000', 0, '165'],
    ['link preview noise', '#Polderprikker nummer 166 • 5000/5000\n🟦1000 🟦1000 🟦1000 🟦1000 🟦1000\nhttps://polderprikker.nl/\nPolderprikker - Raad waar in Nederland', 5000, '166'],
  ])('handles %s', (_label, text, score, puzzle) => {
    expect(polderprikker.parse(text)).toEqual({ score, maxScore: 5000, puzzle });
  });

  it.each([
    ['score above max', '#Polderprikker nummer 158 • 5478/5000'],
    ['just talking about it', 'Wie heeft de polderprikker al gedaan?'],
    ['only the link', 'https://polderprikker.nl/'],
    ['no score', '#Polderprikker nummer 158'],
  ])('rejects %s', (_label, text) => {
    expect(polderprikker.parse(text)).toBeNull();
  });
});

describe('MapTap', () => {
  it('parses the canonical share text', () => {
    const text = 'www.maptap.gg November 6\n100🎯 100🎯 93🏆 97🔥 89🎉\nFinal score: 944';
    expect(maptap.parse(text)).toEqual({ score: 944, maxScore: 1000, puzzleDate: { month: 11, day: 6 } });
  });

  it.each([
    ['https, short month, "Final Score" without colon', 'https://maptap.gg Nov 7\n90🎯 80 70 60 50\nFinal Score 812', 812, { month: 11, day: 7 }],
    ['day before month, Dutch month', 'maptap.gg 6 november\n100🎯 100🎯 100🎯 100🎯 100🎯\nFinal score: 1000', 1000, { month: 11, day: 6 }],
    ['link preview after the result', 'www.maptap.gg December 31\n10 20 30 40 50\nFinal score: 321\n\nMapTap - a daily geography game\nmaptap.gg', 321, { month: 12, day: 31 }],
    ['extra whitespace and emoji presentation selectors', 'www.maptap.gg   January  2 \n100🎯️ 93🏆️\nFinal   score :  77', 77, { month: 1, day: 2 }],
  ])('handles %s', (_label, text, score, puzzleDate) => {
    expect(maptap.parse(text)).toEqual({ score, maxScore: 1000, puzzleDate });
  });

  it('accepts a result without a date', () => {
    expect(maptap.parse('maptap.gg\nFinal score: 500')).toEqual({ score: 500, maxScore: 1000 });
  });

  it.each([
    ['score above 1000', 'www.maptap.gg November 6\nFinal score: 1200'],
    ['site mention without score', 'maptap.gg is leuk, probeer het eens'],
    ['score without the site', 'Final score: 900'],
  ])('rejects %s', (_label, text) => {
    expect(maptap.parse(text)).toBeNull();
  });
});

describe('parseScores', () => {
  it('finds both games in one message', () => {
    const text = '#Polderprikker nummer 158 • 4478/5000\n\nwww.maptap.gg November 6\nFinal score: 944';
    expect(parseScores(text).map((r) => [r.game.id, r.result.score])).toEqual([
      ['polderprikker', 4478],
      ['maptap', 944],
    ]);
  });

  it('returns nothing for normal chat', () => {
    expect(parseScores('Hoi allemaal, wie komt er vrijdag?')).toEqual([]);
  });
});
