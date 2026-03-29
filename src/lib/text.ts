export function truncateText(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength).trimEnd() + "…";
}

export function extractPathMentions(text: string): string[] {
  const pathPattern = /(?:^|\s)([\w./-]+\/[\w./-]+\.[\w]+)/g;
  const matches: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = pathPattern.exec(text)) !== null) {
    matches.push(match[1]!);
  }
  return [...new Set(matches)];
}

export function cleanIssueBody(body: string | null): string {
  if (!body) return "";
  return body
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/```[\s\S]*?```/g, "[code block]")
    .replace(/\r\n/g, "\n")
    .trim();
}

export function buildEmbeddingDocument(title: string, body: string | null, maxLen = 2048): string {
  const cleaned = cleanIssueBody(body);
  const combined = cleaned ? `${title}\n\n${cleaned}` : title;
  return truncateText(combined, maxLen);
}
