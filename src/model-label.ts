/**
 * What the header calls the current model (issue #92).
 *
 * The header has one line and shares it with the workspace, the menu and the
 * connection dot, so the label has to be short enough to survive at 320px. Two
 * rules, in order:
 *
 * 1. Prefer the provider's own display name. `gemini-flash-lite-latest` is
 *    what the provider calls it and what the picker lists, so the header
 *    should agree with the picker.
 * 2. Otherwise fall back to the last segment of the id, not the whole id.
 *    Ids are provider-prefixed — `google-ai-studio/gemini-3.1-flash-lite` is
 *    38 characters — and ellipsizing one from the right destroys exactly the
 *    half that identifies the model: `google-ai-studio/gemi…` says nothing.
 *    Trimming the prefix instead keeps `gemini-3.1-flash-lite`. The provider
 *    is not lost: the picker groups by it, and the agent strip prints
 *    `(provider) id` whenever more than one provider is configured.
 *
 * The result is still ellipsized in CSS — a single segment can be long — but
 * it starts from the informative end.
 */
export function modelLabel(name?: string | null, modelId?: string | null): string {
  const named = name?.trim();
  if (named) return named;

  const id = modelId?.trim();
  if (!id) return "Model";

  // Only a segment that carries something wins; a trailing slash keeps the id.
  const tail = id.slice(id.lastIndexOf("/") + 1).trim();
  return tail || id;
}
