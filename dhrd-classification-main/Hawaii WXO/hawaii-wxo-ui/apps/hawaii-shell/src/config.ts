/**
 * config.ts — boot config for hawaii-shell.
 *
 * Set VITE_HAWAII_API_BASE (e.g. "/api" with the vite dev proxy) to go live.
 * Leave it unset and the app shows the "not configured" screen.
 */
import { configureApi, configureBranding } from 'wxo-custom-ui';
import { brand } from './brand';

const apiBase = (import.meta.env.VITE_HAWAII_API_BASE as string | undefined) ?? '';

export const liveConfigured = apiBase !== '';

if (liveConfigured) configureApi({ base: apiBase });
configureBranding({ wordmark: brand.wordmark });
