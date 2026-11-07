import { describe, expect, it } from 'vitest';
import { firstName, makeNameLookup } from '../src/names.js';

const player = (jid: string, name: string, phone: string | null = null) => ({ jid, phone_jid: phone, name, updated_at: 1 });

describe('names', () => {
  it('takes the first real word of a name', () => {
    expect(firstName('Bob Jansen')).toBe('Bob');
    expect(firstName('~ 🎯 Eva de Wit')).toBe('Eva');
    expect(firstName('Kim')).toBe('Kim');
  });

  it('shows first names, full names only when two players share one, and aliases first', () => {
    const nameOf = makeNameLookup(new Map([['316000@s.whatsapp.net', 'Joop']]), [
      player('1@lid', 'Bob Jansen'),
      player('2@lid', 'Anna de Vries'),
      player('3@lid', 'Anna Bakker'),
      player('4@lid', 'Kees Smit', '316000@s.whatsapp.net'),
    ]);
    expect(nameOf('1@lid')).toBe('Bob');
    expect(nameOf('2@lid')).toBe('Anna de Vries');
    expect(nameOf('3@lid')).toBe('Anna Bakker');
    expect(nameOf('4@lid')).toBe('Joop');
    expect(nameOf('9@lid', 'Zoe van Dam')).toBe('Zoe');
    expect(nameOf('123456789@lid')).toBe('~6789');
  });
});
