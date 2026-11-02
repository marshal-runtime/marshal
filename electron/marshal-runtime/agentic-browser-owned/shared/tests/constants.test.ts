import { describe, it, expect } from 'vitest';
import {
  DEFAULT_TIMEOUT,
  MAX_RETRY_COUNT,
  DEFAULT_TYPE_DELAY,
  DEFAULT_SCREENSHOT_FORMAT,
  DEFAULT_SCREENSHOT_QUALITY,
  MAX_MESSAGE_SIZE,
} from '../constants/index.js';

describe('Constants', () => {
  describe('defaults', () => {
    it('should export DEFAULT_TIMEOUT as a positive number', () => {
      // Arrange
      const expected = 30_000;

      // Act
      const actual = DEFAULT_TIMEOUT;

      // Assert
      expect(actual).toBe(expected);
      expect(actual).toBeGreaterThan(0);
    });

    it('should export MAX_RETRY_COUNT as a positive integer', () => {
      // Arrange & Act
      const actual = MAX_RETRY_COUNT;

      // Assert
      expect(actual).toBe(3);
      expect(Number.isInteger(actual)).toBe(true);
      expect(actual).toBeGreaterThan(0);
    });

    it('should export DEFAULT_TYPE_DELAY as a positive number', () => {
      // Arrange & Act
      const actual = DEFAULT_TYPE_DELAY;

      // Assert
      expect(actual).toBe(50);
      expect(actual).toBeGreaterThan(0);
    });

    it('should export DEFAULT_SCREENSHOT_FORMAT as png', () => {
      // Arrange & Act
      const actual = DEFAULT_SCREENSHOT_FORMAT;

      // Assert
      expect(actual).toBe('png');
    });

    it('should export DEFAULT_SCREENSHOT_QUALITY in valid range', () => {
      // Arrange & Act
      const actual = DEFAULT_SCREENSHOT_QUALITY;

      // Assert
      expect(actual).toBe(80);
      expect(actual).toBeGreaterThanOrEqual(1);
      expect(actual).toBeLessThanOrEqual(100);
    });

    it('should export MAX_MESSAGE_SIZE as 1 MiB', () => {
      // Arrange
      const oneMiB = 1_024 * 1_024;

      // Act
      const actual = MAX_MESSAGE_SIZE;

      // Assert
      expect(actual).toBe(oneMiB);
    });
  });
});
