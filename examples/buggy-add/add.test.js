import { test } from 'node:test';
import assert from 'node:assert/strict';
import { add } from './add.js';
test('adds two positive numbers', () => assert.equal(add(2, 3), 5));
test('adds a negative number', () => assert.equal(add(4, -2), 2));
