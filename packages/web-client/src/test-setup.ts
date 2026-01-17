/**
 * Test setup file for Vitest
 *
 * This file is run before each test file to set up the testing environment.
 */

import '@testing-library/jest-dom';

// Mock HTMLMediaElement
Object.defineProperty(window.HTMLMediaElement.prototype, 'muted', {
  set: function() {},
});

Object.defineProperty(window.HTMLMediaElement.prototype, 'play', {
  value: function() {
    return Promise.resolve();
  },
});

Object.defineProperty(window.HTMLMediaElement.prototype, 'pause', {
  value: function() {},
});

// Mock srcObject for video elements
Object.defineProperty(window.HTMLMediaElement.prototype, 'srcObject', {
  set: function() {},
  get: function() {
    return null;
  },
});

// Mock scrollIntoView
Element.prototype.scrollIntoView = function() {};
