---
'@pi-plugins/webfetch': patch
---

Cap the collapsed result preview at five wrapped terminal rows. It previously showed
ten source lines, which for a fetched page is ten paragraphs and wrapped to a wall of
text.
