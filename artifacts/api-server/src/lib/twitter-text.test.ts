import { describe, expect, it } from "vitest";
import { postLength, twitterLength } from "./twitter-text";

// X's weighted length: the examples follow twitter-text's published rules (a link is 23; CJK and emoji are 2).

describe("twitterLength", () => {
  it("counts plain Latin text one per character", () => {
    expect(twitterLength("")).toBe(0);
    expect(twitterLength("Hello, world!")).toBe(13);
    expect(twitterLength("a".repeat(280))).toBe(280);
  });

  it("counts accented and other alphabetic scripts as one, composed or not", () => {
    expect(twitterLength("café")).toBe(4);
    expect(twitterLength("café")).toBe(4); // e + combining accent is normalised first
    expect(twitterLength("Привет")).toBe(6);
    expect(twitterLength("नमस्ते")).toBe(6);
  });

  it("counts Chinese, Japanese and Korean as two each", () => {
    expect(twitterLength("你好")).toBe(4);
    expect(twitterLength("こんにちは")).toBe(10);
    expect(twitterLength("안녕")).toBe(4);
  });

  it("counts an emoji as two, however it is built", () => {
    expect(twitterLength("👍")).toBe(2);
    expect(twitterLength("👍🏽")).toBe(2); // with a skin tone
    expect(twitterLength("👨‍👩‍👧‍👦")).toBe(2); // a family joined from four people
    expect(twitterLength("🇮🇳")).toBe(2); // a flag
    expect(twitterLength("1️⃣")).toBe(2); // a keycap
    expect(twitterLength("Go 🚀🚀")).toBe(7);
  });

  it("counts every link as 23, whatever its real length", () => {
    expect(twitterLength("https://example.com")).toBe(23);
    expect(twitterLength("http://a.co")).toBe(23);
    expect(twitterLength(`https://example.com/${"x".repeat(300)}?utm_source=socialflow`)).toBe(23);
    expect(twitterLength("Read https://example.com/a and https://example.org/b")).toBe(5 + 23 + 5 + 23);
  });

  it("leaves the punctuation after a link to the sentence", () => {
    expect(twitterLength("See https://example.com/story.")).toBe(4 + 23 + 1);
    expect(twitterLength("(https://example.com)")).toBe(1 + 23 + 1);
  });

  it("treats a bare domain as a link, but not an email address or an abbreviation", () => {
    expect(twitterLength("example.com")).toBe(23);
    expect(twitterLength("Visit example.io/pricing today")).toBe(6 + 23 + 6);
    expect(twitterLength("me@example.com")).toBe(14);
    expect(twitterLength("e.g. this, i.e. that")).toBe(20);
    expect(twitterLength("Version 2.5 is out")).toBe(18);
  });

  it("is the limit a real post is held to", () => {
    const text = `${"a".repeat(256)} https://example.com/a-very-long-address-that-would-not-fit-if-counted-in-full`;
    expect(text.length).toBeGreaterThan(280);
    expect(twitterLength(text)).toBe(280);
  });
});

describe("postLength", () => {
  it("uses X's count only for X", () => {
    const text = "你好 https://example.com/a-long-address";
    expect(postLength("twitter", text)).toBe(4 + 1 + 23);
    expect(postLength("linkedin", text)).toBe(text.length);
    expect(postLength("facebook", text)).toBe(text.length);
  });
});
