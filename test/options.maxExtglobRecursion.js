'use strict';

const assert = require('assert');
const { isMatch, makeRe, parse } = require('..');

/**
 * Reject increasingly long crafted inputs, failing as soon as one of them is
 * slow. Exponential backtracking makes every step 16x slower than the last,
 * so a vulnerable pattern fails within a few seconds instead of hanging.
 */

const assertFastReject = (pattern, createInput, options) => {
  for (let length = 8; length <= 32; length += 4) {
    const input = createInput(length);
    const start = Date.now();
    const matched = isMatch(input, pattern, options);
    const elapsed = Date.now() - start;

    assert(!matched, `expected "${pattern}" not to match ${JSON.stringify(input)}`);
    assert(elapsed < 250, `"${pattern}" took ${elapsed}ms to reject ${JSON.stringify(input)}`);
  }
};

describe('options.maxExtglobRecursion', () => {
  it('should literalize risky repeated extglobs by default', () => {
    assert.strictEqual(
      makeRe('+(a|aa)').source,
      '^(?:\\+\\(a\\|aa\\))$'
    );
    assert.strictEqual(
      makeRe('+(*|?)').source,
      '^(?:\\+\\(\\*\\|\\?\\))$'
    );
    assert.strictEqual(
      makeRe('+(+(a))').source,
      '^(?:\\+\\(\\+\\(a\\)\\))$'
    );
    assert.strictEqual(
      makeRe('*(+(a))').source,
      '^(?:\\*\\(\\+\\(a\\)\\))$'
    );

    assert(!isMatch('a'.repeat(20) + 'b', '+(a|aa)'));
    assert(!isMatch('a'.repeat(12) + '!', '+(+(a))'));
  });

  it('should preserve non-risky extglobs by default', () => {
    assert(isMatch('abcabc', '+(abc)'));
    assert(isMatch('foobar', '*(foo|bar)'));
    assert(isMatch('a', '(a|@(b|c)|d)'));
    assert(isMatch('fffooo', '*(*(f)*(o))'));
    assert(isMatch('abc', '+(*)c'));
  });

  it('should allow limited nested repeated extglobs when configured', () => {
    assert.strictEqual(
      makeRe('+(+(a))', { maxExtglobRecursion: 1 }).source,
      '^(?:(?=.)(?:(?:a)+)+)$'
    );
    assert.strictEqual(
      makeRe('*(+(a))', { maxExtglobRecursion: 1 }).source,
      '^(?:(?=.)(?:(?:a)+)*)$'
    );

    assert(isMatch('aaa', '+(+(a))', { maxExtglobRecursion: 1 }));
    assert(isMatch('aaa', '*(+(a))', { maxExtglobRecursion: 1 }));
  });

  it('should still block ambiguous repeated alternation when recursion is allowed', () => {
    assert.strictEqual(
      makeRe('+(a|aa)', { maxExtglobRecursion: 1 }).source,
      '^(?:\\+\\(a\\|aa\\))$'
    );
    assert.strictEqual(
      makeRe('+(*|?)', { maxExtglobRecursion: 1 }).source,
      '^(?:\\+\\(\\*\\|\\?\\))$'
    );
  });

  it('should rewrite risky repeated extglobs embedded in larger patterns', () => {
    assert.strictEqual(
      makeRe('foo/+(a|aa)/bar').source,
      '^(?:foo\\/\\+\\(a\\|aa\\)\\/bar)$'
    );
    assert.strictEqual(
      makeRe('x+(a|aa)y').source,
      '^(?:x\\+\\(a\\|aa\\)y)$'
    );

    assert(isMatch('foo/+(a|aa)/bar', 'foo/+(a|aa)/bar'));
    assert(!isMatch('foo/aa/bar', 'foo/+(a|aa)/bar'));
    assert(isMatch('x+(a|aa)y', 'x+(a|aa)y'));
    assert(!isMatch('xaay', 'x+(a|aa)y'));
  });

  it('should rewrite star-only repeated extglobs embedded in larger patterns', () => {
    assert.strictEqual(
      makeRe('pre*(*(f)*(o))post').source,
      '^(?:pre[fo]*post)$'
    );

    assert(isMatch('prefoopost', 'pre*(*(f)*(o))post'));
  });

  it('should rewrite star-only repeated extglobs', () => {
    assert.strictEqual(
      makeRe('*(*(f))').source,
      '^(?:(?=.)f*)$'
    );

    assert(isMatch('fff', '*(*(f))'));
  });

  it('should preserve capture behavior for rewritten repeated extglobs', () => {
    const embedded = makeRe('foo/+(a|aa)/bar', { capture: true });
    assert.strictEqual(embedded.source, '^(?:foo\\/\\+\\(a\\|aa\\)\\/bar)$');
    assert.deepStrictEqual(
      Array.from(embedded.exec('foo/+(a|aa)/bar')),
      ['foo/+(a|aa)/bar']
    );

    const simplified = makeRe('*(*(f)*(o))', { capture: true });
    assert.strictEqual(simplified.source, '^(?:(?=.)([fo]*))$');
    assert.deepStrictEqual(
      Array.from(simplified.exec('fffooo')),
      ['fffooo', 'fffooo']
    );
  });

  it('should only rewrite the risky repeated extglob when adjacent extglobs are present', () => {
    assert.strictEqual(
      makeRe('+(a|aa)@(x)').source,
      '^(?:\\+\\(a\\|aa\\)(x))$'
    );

    assert(isMatch('+(a|aa)x', '+(a|aa)@(x)'));
    assert(!isMatch('aaax', '+(a|aa)@(x)'));
  });

  it('should drop the outer quantifier of single-branch repeated star extglobs', () => {
    assert.strictEqual(parse('+(*)').output, '(?=.)(?:[^/]*?)');
    assert.strictEqual(parse('*(*)').output, '(?=.)(?:[^/]*?)?');
    assert.strictEqual(parse('+(*a)').output, '(?=.)(?:[^/]*?a)');
    assert.strictEqual(parse('*(*a)').output, '(?=.)(?:[^/]*?a)?');
    assert.strictEqual(parse('+(a*)').output, '(?=.)(?:a[^/]*?)');
    assert.strictEqual(parse('x+(*a)y').output, 'x(?:[^/]*?a)y');
    assert.strictEqual(parse('+(*a)', { windows: true }).output, '(?=.)(?:[^\\\\/]*?a)');
    assert.strictEqual(parse('+(a*b?)').output, '(?=.)(?:a[^/]*?b[^/])');

    // `*(body)` compiles like `?(body)`, and `+(body)` like `?(body)` without the `?`
    const bodies = ['*', '*a', 'a*', '*a*', '*.js', '**', '!(f)', '!(foo)', '!(*.js)'];
    for (const body of bodies) {
      for (const options of [{}, { windows: true }, { bash: true }, { capture: true }]) {
        const once = parse(`?(${body})`, options).output;
        const plus = once.replace(/\)\?(\)?)$/, ')$1');
        assert.strictEqual(parse(`+(${body})`, options).output, plus, `+(${body})`);
        assert.strictEqual(parse(`*(${body})`, options).output, once, `*(${body})`);
      }
    }
  });

  it('should preserve matching for collapsed single-branch repeated extglobs', () => {
    assert(isMatch('abc', '+(*)'));
    assert(isMatch('abc', '*(*)'));
    assert(!isMatch('a/b', '+(*)'));
    assert(isMatch('abc', '+(*)c'));
    assert(!isMatch('abc', '+(*)x'));

    assert(isMatch('a', '+(*a)'));
    assert(isMatch('aaa', '+(*a)'));
    assert(isMatch('bba', '+(*a)'));
    assert(!isMatch('ab', '+(*a)'));
    assert(isMatch('x', '*(*a)x'));
    assert(isMatch('bax', '*(*a)x'));
    assert(!isMatch('bx', '*(*a)x'));

    assert(isMatch('abc', '+(a*)'));
    assert(!isMatch('bc', '+(a*)'));
    assert(isMatch('foo.js', '+(*.js)'));
    assert(isMatch('foo.js.js', '+(*.js)'));
    assert(!isMatch('foo.ts', '+(*.js)'));

    assert(isMatch('fff', '+(!(f))'));
    assert(!isMatch('f', '+(!(f))'));
    assert(!isMatch('f', '*(!(f))'));
    assert(isMatch('bar', '*(!(foo))'));

    assert(isMatch('aaa', '+(*a)', { windows: true }));
    assert(!isMatch('b', '+(*a)', { windows: true }));
    assert(isMatch('a/ba', '+(*a)', { bash: true }));

    const captured = makeRe('+(*a)', { capture: true }).exec('bba');
    assert.strictEqual(captured[0], 'bba');
    assert.strictEqual(captured[1], 'bba');
  });

  it('should reject crafted input quickly for single-branch repeated star extglobs', () => {
    assertFastReject('+(*)', n => 'a'.repeat(n) + '/');
    assertFastReject('*(*)', n => 'a'.repeat(n) + '/');
    assertFastReject('+(*)b', n => 'a'.repeat(n));
    assertFastReject('+(*a)', n => 'a'.repeat(n) + '!');
    assertFastReject('*(*a)', n => 'a'.repeat(n) + '!');
    assertFastReject('+(a*)', n => 'a'.repeat(n) + '/');
    assertFastReject('+(*a*)', n => 'a'.repeat(n) + '/');
    assertFastReject('+(*.js)', n => 'a.js'.repeat(n) + '!');
    assertFastReject('+(**)', n => 'a'.repeat(n) + '\n');
    assertFastReject('+(!(f))', n => 'a'.repeat(n) + '/');
    assertFastReject('x+(*a)y', n => 'x' + 'a'.repeat(n) + '!y');
    assertFastReject('foo/+(*a)/bar', n => 'foo/' + 'a'.repeat(n) + '!/bar');
  });

  it('should reject crafted input quickly with options for single-branch repeated star extglobs', () => {
    assertFastReject('+(*a)', n => 'a'.repeat(n) + '!', { windows: true });
    assertFastReject('+(*a)', n => 'a'.repeat(n) + '!', { capture: true });
    assertFastReject('+(*a)', n => 'a'.repeat(n) + '!', { bash: true });
    assertFastReject('+(*a)', n => 'a'.repeat(n) + '!', { maxExtglobRecursion: 2 });
  });

  it('should literalize single-branch repeated extglobs that cannot be simplified', () => {
    assert.strictEqual(makeRe('+(*[a])').source, '^(?:\\+\\(\\*\\[a\\]\\))$');
    assert.strictEqual(makeRe('+(@(*a))').source, '^(?:\\+\\(@\\(\\*a\\)\\))$');
    assert.strictEqual(makeRe('+(a+)').source, '^(?:\\+\\(a\\+\\))$');
    assert.strictEqual(makeRe('*(*(a)*)').source, '^(?:\\*\\(\\*\\(a\\)\\*\\))$');
    assert.strictEqual(parse('+(*/*)').output, '\\+\\(\\*/\\*\\)');

    assert(isMatch('+(*[a])', '+(*[a])'));
    assert(!isMatch('aa', '+(*[a])'));

    assertFastReject('+(*[a])', n => 'a'.repeat(n) + '!');
    assertFastReject('+(@(*a))', n => 'a'.repeat(n) + '!');
    assertFastReject('+(a+)', n => 'a'.repeat(n) + '!');
    assertFastReject('*(*(a)*)', n => 'a'.repeat(n) + '/');
    assertFastReject('+(*/*)x', n => 'a/'.repeat(n) + 'y');
  });

  it('should keep single-branch repeated extglobs whose repetitions are pinned by separators', () => {
    assert(/\)\+$/.test(parse('+(*/)').output));
    assert(/\)\*$/.test(parse('*(foo/*)').output));

    assert(isMatch('a/b/', '+(*/)'));
    assert(isMatch('foo/afoo/b', '+(foo/*)'));
    assert(!isMatch('foo/a/foo/b', '+(foo/*)'));

    assertFastReject('+(*/)x', n => 'a/'.repeat(n) + 'y');
    assertFastReject('+(foo/*)x', n => 'foo/a'.repeat(n) + 'y');
  });

  it('should disable the single-branch rewrite when maxExtglobRecursion is false', () => {
    assert(/\)\+$/.test(parse('+(*a)', { maxExtglobRecursion: false }).output));
    assert(/\)\*$/.test(parse('*(*)', { maxExtglobRecursion: false }).output));
  });

  it('should disable the safeguard when maxExtglobRecursion is false', () => {
    assert(
      /\(\?:a\|aa\)\+/.test(
        makeRe('+(a|aa)', { maxExtglobRecursion: false }).source
      )
    );
    assert(
      /\(\?:\(\?:a\)\+\)\+/.test(
        makeRe('+(+(a))', { maxExtglobRecursion: false }).source
      )
    );
  });
});
