/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parseSqlStatements } from './sql-loader.js';

describe('parseSqlStatements', () => {
  it('should parse a single statement', () => {
    const content = `-- selectAll
SELECT * FROM users;`;

    const result = parseSqlStatements(content);

    assert.deepStrictEqual(result, {
      selectAll: 'SELECT * FROM users;',
    });
  });

  it('should parse multiple statements separated by blank lines', () => {
    const content = `-- selectAll
SELECT * FROM users;

-- updateUser
UPDATE users SET name = ? WHERE id = ?;`;

    const result = parseSqlStatements(content);

    assert.deepStrictEqual(result, {
      selectAll: 'SELECT * FROM users;',
      updateUser: 'UPDATE users SET name = ? WHERE id = ?;',
    });
  });

  it('should handle statements at the start of file without blank line', () => {
    const content = `-- firstStatement
SELECT 1;`;

    const result = parseSqlStatements(content);

    assert.deepStrictEqual(result, {
      firstStatement: 'SELECT 1;',
    });
  });

  it('should strip inline comments within statements', () => {
    const content = `-- selectWithComments
SELECT id, -- user identifier
  name, -- user full name
  email
FROM users;`;

    const result = parseSqlStatements(content);

    assert.deepStrictEqual(result, {
      selectWithComments: `SELECT id,
  name,
  email
FROM users;`,
    });
  });

  it('should skip lines starting with block comments', () => {
    const content = `-- selectWithBlockComment
SELECT id,
  /* this is a
     multi-line comment */
  name
FROM users;`;

    const result = parseSqlStatements(content);

    assert.deepStrictEqual(result, {
      selectWithBlockComment: `SELECT id,
  name
FROM users;`,
    });
  });

  it('should handle block comments spanning multiple lines', () => {
    const content = `-- complexQuery
SELECT 
  /*
   * This is a big comment
   * that spans multiple lines
   */
  id, name
FROM users;`;

    const result = parseSqlStatements(content);

    assert.deepStrictEqual(result, {
      complexQuery: `SELECT
  id, name
FROM users;`,
    });
  });

  it('should require blank line before statement names', () => {
    const content = `-- firstStatement
SELECT 1;
-- notAStatement
This should be part of firstStatement;`;

    const result = parseSqlStatements(content);

    assert.deepStrictEqual(result, {
      firstStatement: `SELECT 1;
This should be part of firstStatement;`,
    });
  });

  it('should handle Windows-style line endings', () => {
    const content = `-- statement1\r\nSELECT 1;\r\n\r\n-- statement2\r\nSELECT 2;`;

    const result = parseSqlStatements(content);

    assert.deepStrictEqual(result, {
      statement1: 'SELECT 1;',
      statement2: 'SELECT 2;',
    });
  });

  it('should trim whitespace from statement names', () => {
    const content = `--   statementWithSpaces   
SELECT 1;`;

    const result = parseSqlStatements(content);

    assert.deepStrictEqual(result, {
      statementWithSpaces: 'SELECT 1;',
    });
  });

  it('should handle empty statements', () => {
    const content = `-- emptyStatement

-- nextStatement
SELECT 1;`;

    const result = parseSqlStatements(content);

    assert.deepStrictEqual(result, {
      emptyStatement: '',
      nextStatement: 'SELECT 1;',
    });
  });

  it('should handle statements with only whitespace', () => {
    const content = `-- whitespaceOnly
   
   
-- nextStatement
SELECT 1;`;

    const result = parseSqlStatements(content);

    assert.deepStrictEqual(result, {
      whitespaceOnly: '',
      nextStatement: 'SELECT 1;',
    });
  });

  it('should parse complex SQL with multiple comment types', () => {
    const content = `-- createTable
CREATE TABLE users (
  id INTEGER PRIMARY KEY, -- primary key
  name TEXT NOT NULL, -- user name
  /* email field with unique constraint */
  email TEXT UNIQUE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- insertUser
INSERT INTO users (name, email) 
VALUES (?, ?); -- bind parameters

-- selectActiveUsers
SELECT 
  id,
  name,
  email
FROM users
WHERE 
  /* Check if user is active based on:
     1. Not deleted
     2. Verified email
  */
  deleted_at IS NULL
  AND email_verified = true
ORDER BY created_at DESC;`;

    const result = parseSqlStatements(content);

    assert.deepStrictEqual(result, {
      createTable: `CREATE TABLE users (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT UNIQUE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);`,
      insertUser: `INSERT INTO users (name, email)
VALUES (?, ?);`,
      selectActiveUsers: `SELECT
  id,
  name,
  email
FROM users
WHERE
  deleted_at IS NULL
  AND email_verified = true
ORDER BY created_at DESC;`,
    });
  });

  it('should handle block comments that close on same line', () => {
    const content = `-- queryWithInlineBlock
SELECT /* inline comment */ id FROM users;`;

    const result = parseSqlStatements(content);

    assert.deepStrictEqual(result, {
      queryWithInlineBlock: 'SELECT  id FROM users;',
    });
  });

  it('should not parse content before first statement', () => {
    const content = `This is some header text
that should be ignored

-- firstStatement
SELECT 1;`;

    const result = parseSqlStatements(content);

    assert.deepStrictEqual(result, {
      firstStatement: 'SELECT 1;',
    });
  });

  it('should handle statement names with special characters', () => {
    const content = `-- select-with-dashes
SELECT 1;

-- select_with_underscores
SELECT 2;

-- selectWithNumbers123
SELECT 3;`;

    const result = parseSqlStatements(content);

    assert.deepStrictEqual(result, {
      'select-with-dashes': 'SELECT 1;',
      select_with_underscores: 'SELECT 2;',
      selectWithNumbers123: 'SELECT 3;',
    });
  });

  it('should handle consecutive blank lines between statements', () => {
    const content = `-- statement1
SELECT 1;



-- statement2
SELECT 2;`;

    const result = parseSqlStatements(content);

    assert.deepStrictEqual(result, {
      statement1: 'SELECT 1;',
      statement2: 'SELECT 2;',
    });
  });

  it('should handle tabs and mixed whitespace', () => {
    const content = `-- statement1
SELECT\t1;

\t\t
-- statement2
SELECT 2;`;

    const result = parseSqlStatements(content);

    assert.deepStrictEqual(result, {
      statement1: 'SELECT\t1;',
      statement2: 'SELECT 2;',
    });
  });

  it('should handle empty input', () => {
    const result = parseSqlStatements('');
    assert.deepStrictEqual(result, {});
  });

  it('should handle input with only comments', () => {
    const content = `-- This is just a comment
-- Another comment`;

    const result = parseSqlStatements(content);
    assert.deepStrictEqual(result, {
      'This is just a comment': '',
    });
  });

  it('should preserve indentation within statements', () => {
    const content = `-- formattedQuery
SELECT 
    id,
    name,
    email
FROM 
    users
WHERE 
    active = true;`;

    const result = parseSqlStatements(content);

    assert.deepStrictEqual(result, {
      formattedQuery: `SELECT
    id,
    name,
    email
FROM
    users
WHERE
    active = true;`,
    });
  });

  it('should handle block comments with */ in string literals correctly', () => {
    const content = `-- queryWithTrickyComment
SELECT '/* this is not a comment */' as text
/* but this is */
FROM dual;`;

    const result = parseSqlStatements(content);

    assert.deepStrictEqual(result, {
      queryWithTrickyComment: `SELECT '/* this is not a comment */' as text
FROM dual;`,
    });
  });

  it('should handle SQL with -- in string literals', () => {
    const content = `-- queryWithDashesInString
SELECT '-- this is not a comment' as text
FROM dual;`;

    const result = parseSqlStatements(content);

    assert.deepStrictEqual(result, {
      queryWithDashesInString: `SELECT '-- this is not a comment' as text
FROM dual;`,
    });
  });

  it('should strip trailing whitespace from statements', () => {
    const content = `-- statementWithTrailing
SELECT 1;   \t   

-- nextStatement
SELECT 2;`;

    const result = parseSqlStatements(content);

    assert.deepStrictEqual(result, {
      statementWithTrailing: 'SELECT 1;',
      nextStatement: 'SELECT 2;',
    });
  });

  it('should handle CodeRabbit edge case: inline block comment with SQL after', () => {
    const content = `-- hintQuery
/* hint */ SELECT 1;`;

    const result = parseSqlStatements(content);

    assert.deepStrictEqual(result, {
      hintQuery: 'SELECT 1;',
    });
  });

  it('should prevent SQL preparation errors by stripping problematic comments', () => {
    const content = `-- problematicQuery
SELECT * FROM foo -- tenant filter
WHERE id = 1; -- another comment`;

    const result = parseSqlStatements(content);

    assert.deepStrictEqual(result, {
      problematicQuery: `SELECT * FROM foo
WHERE id = 1;`,
    });
  });

  it('should handle escaped quotes in string literals correctly', () => {
    const content = `-- queryWithEscapedQuotes
SELECT 'This is a \\'comment\\' -- not really' as text
FROM dual;`;

    const result = parseSqlStatements(content);

    assert.deepStrictEqual(result, {
      queryWithEscapedQuotes: `SELECT 'This is a \\'comment\\' -- not really' as text
FROM dual;`,
    });
  });

  it('should handle nested comment-like sequences', () => {
    const content = `-- nestedComments
SELECT '/* not a comment */' as text1, -- this is a comment
       '-- also not a comment' as text2 /* this is a comment */
FROM dual;`;

    const result = parseSqlStatements(content);

    assert.deepStrictEqual(result, {
      nestedComments: `SELECT '/* not a comment */' as text1,
       '-- also not a comment' as text2
FROM dual;`,
    });
  });

  it('should handle multiple inline block comments on same line', () => {
    const content = `-- multipleBlockComments
SELECT /* comment1 */ id, /* comment2 */ name /* comment3 */ FROM users;`;

    const result = parseSqlStatements(content);

    assert.deepStrictEqual(result, {
      multipleBlockComments: 'SELECT  id,  name  FROM users;',
    });
  });
});
