import { Actor, log } from 'apify';
import { gotScraping } from 'got-scraping';
import type { ActorInput, ScrapedRecord } from '../types.js';

const postToWebhook = async (
    url: string,
    token: string | null,
    payload: ScrapedRecord | ScrapedRecord[],
): Promise<void> => {
    const headers: Record<string, string> = {
        'Content-Type': 'application/json',
    };
    if (token) {
        headers['Authorization'] = `Bearer ${token}`;
    }

    const response = await gotScraping.post(url, {
        headers,
        body: JSON.stringify(payload),
        responseType: 'text',
        retry: { limit: 2 },
        timeout: { request: 30_000 },
    });

    if (response.statusCode < 200 || response.statusCode >= 300) {
        throw new Error(`Webhook responded with status ${response.statusCode}: ${response.body}`);
    }

    log.debug(`Webhook POST succeeded`, { status: response.statusCode, url });
};

export const deliverResults = async (
    results: ScrapedRecord[],
    input: ActorInput,
): Promise<void> => {
    if (results.length === 0) {
        log.warning('No results to deliver');
        return;
    }

    if (input.webhookUrl) {
        log.info(`Delivering ${results.length} record(s) via webhook`, {
            url: input.webhookUrl,
            mode: input.webhookDeliveryMode,
        });

        try {
            if (input.webhookDeliveryMode === 'per-record') {
                for (const record of results) {
                    await postToWebhook(input.webhookUrl, input.webhookAuthToken, record);
                    log.debug(`Webhook delivered record: ${record.spt_id}`);
                }
            } else {
                const batchUrl = input.webhookUrl.endsWith('/batch')
                    ? input.webhookUrl
                    : `${input.webhookUrl.replace(/\/?$/, '')}/batch`;
                await postToWebhook(batchUrl, input.webhookAuthToken, results);
                log.info(`Webhook batch delivered ${results.length} records`);
            }
        } catch (err) {
            log.error('Webhook delivery failed — falling back to Apify Dataset', {
                error: String(err),
            });
            await writeToDataset(results);
        }
    } else {
        log.info(`No webhookUrl configured — writing ${results.length} records to Apify Dataset`);
        await writeToDataset(results);
    }
};

const writeToDataset = async (results: ScrapedRecord[]): Promise<void> => {
    const dataset = await Actor.openDataset();
    for (const record of results) {
        await dataset.pushData(record);
    }
    log.info(`Wrote ${results.length} records to Apify Dataset`);
};
