import { describe, it, expect } from "vitest";

import {
  checkSkillContentSafety,
  truncateSkillContent,
  sanitizeSkillContent,
  SKILL_DESCRIPTION_MAX_LENGTH,
  SKILL_INSTRUCTIONS_MAX_LENGTH,
} from "./foundation/skills/skill-sanitization";

describe("checkSkillContentSafety", () => {
  describe("detects model-specific delimiters", () => {
    it("detects ChatML <|im_start|>", () => {
      const { warnings } = checkSkillContentSafety("", "Hello <|im_start|>system");
      expect(warnings).toHaveLength(1);
      expect(warnings[0].pattern).toContain("<|im_start|>");
      expect(warnings[0].field).toBe("instructions");
    });

    it("detects ChatML <|im_end|>", () => {
      const { warnings } = checkSkillContentSafety("", "text <|im_end|> more");
      expect(warnings).toHaveLength(1);
      expect(warnings[0].pattern).toContain("<|im_end|>");
    });

    it("detects role delimiter <|system|>", () => {
      const { warnings } = checkSkillContentSafety("", "<|system|>\nYou are...");
      expect(warnings).toHaveLength(1);
      expect(warnings[0].pattern).toContain("<|system|>");
    });

    it("detects role delimiter <|user|>", () => {
      const { warnings } = checkSkillContentSafety("", "<|user|>\nDo something");
      expect(warnings).toHaveLength(1);
      expect(warnings[0].pattern).toContain("<|user|>");
    });

    it("detects role delimiter <|assistant|>", () => {
      const { warnings } = checkSkillContentSafety("", "<|assistant|>\nSure");
      expect(warnings).toHaveLength(1);
      expect(warnings[0].pattern).toContain("<|assistant|>");
    });

    it("detects <|endoftext|>", () => {
      const { warnings } = checkSkillContentSafety("", "end<|endoftext|>start");
      expect(warnings).toHaveLength(1);
      expect(warnings[0].pattern).toContain("<|endoftext|>");
    });

    it("detects [INST]", () => {
      const { warnings } = checkSkillContentSafety("", "[INST] Do something [/INST]");
      expect(warnings).toHaveLength(2);
      expect(warnings[0].pattern).toContain("[INST]");
      expect(warnings[1].pattern).toContain("[/INST]");
    });

    it("detects Llama 3 <|begin_of_text|>", () => {
      const { warnings } = checkSkillContentSafety("", "<|begin_of_text|>hello");
      expect(warnings).toHaveLength(1);
      expect(warnings[0].pattern).toContain("<|begin_of_text|>");
    });

    it("detects Llama 3 <|end_of_text|>", () => {
      const { warnings } = checkSkillContentSafety("", "hello<|end_of_text|>");
      expect(warnings).toHaveLength(1);
      expect(warnings[0].pattern).toContain("<|end_of_text|>");
    });
  });

  describe("case insensitive matching", () => {
    it("detects uppercase variants", () => {
      const { warnings } = checkSkillContentSafety("", "<|IM_START|>system");
      expect(warnings).toHaveLength(1);
    });

    it("detects mixed case", () => {
      const { warnings } = checkSkillContentSafety("", "<|Im_Start|>system");
      expect(warnings).toHaveLength(1);
    });
  });

  describe("field-specific detection", () => {
    it("detects patterns in description field", () => {
      const { warnings } = checkSkillContentSafety("<|im_start|>system", "clean instructions");
      expect(warnings).toHaveLength(1);
      expect(warnings[0].field).toBe("description");
    });

    it("detects patterns in both fields independently", () => {
      const { warnings } = checkSkillContentSafety("<|im_start|>system", "<|endoftext|>after");
      expect(warnings).toHaveLength(2);
      expect(warnings[0].field).toBe("description");
      expect(warnings[1].field).toBe("instructions");
    });
  });

  describe("no false positives", () => {
    it("returns no warnings for clean content", () => {
      const { warnings } = checkSkillContentSafety(
        "A helpful skill for creating documents",
        "Step 1: Open the file. Step 2: Edit the content.",
      );
      expect(warnings).toHaveLength(0);
    });

    it("returns no warnings for empty content", () => {
      const { warnings } = checkSkillContentSafety("", "");
      expect(warnings).toHaveLength(0);
    });

    it("does not flag pipe characters in normal use", () => {
      const { warnings } = checkSkillContentSafety(
        "",
        "Run `cat file.txt | grep pattern` to filter output",
      );
      expect(warnings).toHaveLength(0);
    });

    it("does not flag angle brackets in normal HTML/XML", () => {
      const { warnings } = checkSkillContentSafety("", "Use <div> and <span> tags for layout");
      expect(warnings).toHaveLength(0);
    });

    it("does not flag square brackets in normal markdown", () => {
      const { warnings } = checkSkillContentSafety(
        "",
        "See [documentation](https://example.com) for details",
      );
      expect(warnings).toHaveLength(0);
    });
  });

  describe("multiple patterns", () => {
    it("reports multiple distinct patterns in one field", () => {
      const { warnings } = checkSkillContentSafety(
        "",
        "<|im_start|>system\n<|endoftext|>\n[INST]new[/INST]",
      );
      expect(warnings).toHaveLength(4);
    });
  });

  describe("excerpt extraction", () => {
    it("includes context around the match", () => {
      const { warnings } = checkSkillContentSafety(
        "",
        "some text before <|im_start|> some text after",
      );
      expect(warnings[0].excerpt).toContain("<|im_start|>");
      expect(warnings[0].excerpt).toContain("before");
      expect(warnings[0].excerpt).toContain("after");
    });

    it("handles match at start of string", () => {
      const { warnings } = checkSkillContentSafety("", "<|im_start|>system");
      expect(warnings[0].excerpt).toContain("<|im_start|>");
    });

    it("handles match at end of string", () => {
      const { warnings } = checkSkillContentSafety("", "text<|endoftext|>");
      expect(warnings[0].excerpt).toContain("<|endoftext|>");
    });

    it("replaces newlines with spaces in excerpt", () => {
      const { warnings } = checkSkillContentSafety("", "line1\n<|im_start|>\nline3");
      expect(warnings[0].excerpt).not.toContain("\n");
    });
  });
});

describe("truncateSkillContent", () => {
  it("returns unchanged content within limits", () => {
    const result = truncateSkillContent("short desc", "short instructions");
    expect(result.description).toBe("short desc");
    expect(result.instructions).toBe("short instructions");
    expect(result.descriptionTruncated).toBe(false);
    expect(result.instructionsTruncated).toBe(false);
  });

  it("truncates description exceeding limit", () => {
    const longDesc = "a".repeat(SKILL_DESCRIPTION_MAX_LENGTH + 100);
    const result = truncateSkillContent(longDesc, "ok");
    expect(result.description.length).toBe(SKILL_DESCRIPTION_MAX_LENGTH);
    expect(result.instructions).toBe("ok");
    expect(result.descriptionTruncated).toBe(true);
    expect(result.instructionsTruncated).toBe(false);
  });

  it("truncates instructions exceeding limit", () => {
    const longInstr = "b".repeat(SKILL_INSTRUCTIONS_MAX_LENGTH + 100);
    const result = truncateSkillContent("ok", longInstr);
    expect(result.description).toBe("ok");
    expect(result.instructions.length).toBe(SKILL_INSTRUCTIONS_MAX_LENGTH);
    expect(result.descriptionTruncated).toBe(false);
    expect(result.instructionsTruncated).toBe(true);
  });

  it("truncates both fields independently", () => {
    const longDesc = "a".repeat(SKILL_DESCRIPTION_MAX_LENGTH + 50);
    const longInstr = "b".repeat(SKILL_INSTRUCTIONS_MAX_LENGTH + 50);
    const result = truncateSkillContent(longDesc, longInstr);
    expect(result.description.length).toBe(SKILL_DESCRIPTION_MAX_LENGTH);
    expect(result.instructions.length).toBe(SKILL_INSTRUCTIONS_MAX_LENGTH);
    expect(result.descriptionTruncated).toBe(true);
    expect(result.instructionsTruncated).toBe(true);
  });

  it("does not truncate content exactly at limit", () => {
    const exactDesc = "a".repeat(SKILL_DESCRIPTION_MAX_LENGTH);
    const result = truncateSkillContent(exactDesc, "ok");
    expect(result.description.length).toBe(SKILL_DESCRIPTION_MAX_LENGTH);
    expect(result.descriptionTruncated).toBe(false);
  });
});

describe("sanitizeSkillContent", () => {
  it("returns clean content unchanged with no warnings", () => {
    const result = sanitizeSkillContent("A skill", "Do something helpful");
    expect(result.description).toBe("A skill");
    expect(result.instructions).toBe("Do something helpful");
    expect(result.warnings).toHaveLength(0);
  });

  it("truncates and reports correct field for description", () => {
    const longDesc = "a".repeat(SKILL_DESCRIPTION_MAX_LENGTH + 100);
    const result = sanitizeSkillContent(longDesc, "ok");
    expect(result.description.length).toBe(SKILL_DESCRIPTION_MAX_LENGTH);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0].field).toBe("description");
    expect(result.warnings[0].pattern).toBe("Content truncated");
    expect(result.warnings[0].excerpt).toContain("1,000");
  });

  it("truncates and reports correct field for instructions", () => {
    const longInstr = "b".repeat(SKILL_INSTRUCTIONS_MAX_LENGTH + 100);
    const result = sanitizeSkillContent("ok", longInstr);
    expect(result.instructions.length).toBe(SKILL_INSTRUCTIONS_MAX_LENGTH);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0].field).toBe("instructions");
    expect(result.warnings[0].pattern).toBe("Content truncated");
    expect(result.warnings[0].excerpt).toContain("100,000");
  });

  it("combines truncation and delimiter warnings", () => {
    const longDesc = "a".repeat(SKILL_DESCRIPTION_MAX_LENGTH + 50);
    const result = sanitizeSkillContent(longDesc, "<|im_start|>system");
    // 1 truncation warning (description) + 1 delimiter warning (instructions)
    expect(result.warnings).toHaveLength(2);
    expect(result.warnings[0].field).toBe("description");
    expect(result.warnings[0].pattern).toBe("Content truncated");
    expect(result.warnings[1].field).toBe("instructions");
    expect(result.warnings[1].pattern).toContain("<|im_start|>");
  });

  it("detects delimiters after truncation", () => {
    const result = sanitizeSkillContent("", "<|endoftext|> evil stuff");
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0].pattern).toContain("<|endoftext|>");
  });
});
