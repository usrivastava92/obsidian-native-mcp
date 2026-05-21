# Real Heading

Below is a code block whose _content_ must NOT be parsed as headings.

```markdown
# Fake Heading In Code

This whole thing is fenced; the line above must not be a real heading.
```

## Real Subheading

A line with a tag-looking string inside backticks: `not #fake-tag here`.

A real tag: #real-tag

```bash
# this is a shell comment, not a heading
echo "#also-not-a-tag"
```

<!--
## Commented Heading Should Be Ignored
-->

> [!NOTE] Callout
> This is a real Obsidian callout.

Some prose with [a markdown link](https://example.com/#fragment) — the URL
fragment must not become a tag.

A paragraph with a block ref. ^ref-one

- A list item with its own block ref. ^ref-two
- Another item without a ref.

| Col A | Col B       |
| ----- | ----------- |
| a1    | a2 ^row-ref |
| b1    | b2          |

```python
# tilde-fenced shell-comment, also not a heading
```

A `code-heavy.md` ends here.
