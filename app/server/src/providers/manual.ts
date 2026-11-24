import type { BaseProvider, ImagePromptProvider } from './types.ts';

export const manualImport: BaseProvider = {
  id: 'manual-import',
  kind: 'manual_import',
  name: 'Local file import',
  terms: { freeTier: 'Always free and offline', requiresKey: false, commercialUse: 'Depends on the files you import; record their license', privacy: 'Files are copied into the project folder and never uploaded' },
  async healthCheck() {
    return { ok: true, detail: 'Always available' };
  },
};

/** Free-first fallback for AI images: builds a prompt you can run in any generator you already use, then import the result. */
export const manualPrompt: ImagePromptProvider = {
  id: 'manual-prompt',
  kind: 'image_prompt',
  name: 'Manual image prompt (use any generator)',
  terms: { freeTier: 'Always free and offline', requiresKey: false, commercialUse: 'Depends on the generator you use; record it when importing', privacy: 'Nothing is sent anywhere; you copy the prompt yourself' },
  async healthCheck() {
    return { ok: true, detail: 'Always available' };
  },
  buildPrompt({ description, style, assetType, aspect }) {
    const orientation = aspect === '9:16' ? 'vertical portrait composition' : aspect === '1:1' ? 'square composition' : 'wide landscape composition';
    const prompt = [description.trim(), style ? `Style: ${style}.` : '', `${orientation}, subject kept near the centre so it survives re-cropping to other aspect ratios, no text or watermarks.`].filter(Boolean).join(' ');
    return {
      prompt,
      instructions: `Run this in any image generator you can use (local or free-tier), save the result, then import it as "${assetType}" with license type "ai-generated" and note the generator and its terms.`,
    };
  },
};
