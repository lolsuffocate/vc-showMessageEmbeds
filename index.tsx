/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { findGroupChildrenByChildId } from "@api/ContextMenu";
import { updateMessage } from "@api/MessageUpdater";
import { definePluginSettings } from "@api/Settings";
import { ImageVisible } from "@components/Icons";
import { parseUrl } from "@utils/misc";
import definePlugin, { OptionType } from "@utils/types";
import { findByCode } from "@webpack";
import { ChannelStore, Constants, Menu, React, RestAPI, Toasts } from "@webpack/common";
import { Logger } from "@utils/Logger";

const embedCache = new Map<string, any>();


const settings = definePluginSettings({
    // todo remove these if ever released
    "Show vxtiktok Embeds": {
        type: OptionType.BOOLEAN,
        description: "When you show embeds for tiktok links, they will be shown as vxtiktok embeds",
    },
    "Show vxtwitter Embeds": {
        type: OptionType.BOOLEAN,
        description: "When you show embeds for twitter links, they will be shown as vxtwitter embeds",
    },
    "Show ddinstagram Embeds": {
        type: OptionType.BOOLEAN,
        description: "When you show embeds for instagram links, they will be shown as ddinstagram embeds"
    },
    "Show rxddit Embeds": {
        type: OptionType.BOOLEAN,
        description: "When you show embeds for reddit links, they will be shown as rxddit embeds"
    }
});

export default definePlugin({
    name: "ShowMessageEmbeds",
    description: "Adds a context menu option to show embeds for links that don't have one",
    authors: [{
        name: "Suffocate",
        id: 772601756776923187n
    }],
    dependencies: ["MessagePopoverAPI"],
    settings,

    contextMenus: {
        "message": (children, props) => {
            if (props.itemSrc || !props.itemHref) return null; // if the item right-clicked is not a link or is an attachment, don't add

            const { message } = props;
            const origUrl = normaliseUrl(props.itemHref);
            const replacedUrl = replaceSocialMediaLinks(origUrl);

            if (messageContainsEmbedForUrl(message, replacedUrl) ||
                messageContainsAttachmentForUrl(message, replacedUrl)) return null; // try and match the url to an existing embed or attachment (discord only embeds once per url)

            const group = findGroupChildrenByChildId("copy-native-link", children);
            if (!group) return null;

            group.splice(0, 0,
                <Menu.MenuItem
                    id="unfurl-url"
                    label="Show Embed"
                    action={_ => unfurlEmbed(origUrl, replacedUrl, message)}
                    icon={ImageVisible}
                    key="unfurl-url"/>);
        }
    }
});

// special cases where the unfurl api endpoint returns an embed with a different url than the one we requested
// will add more as I come across them
const normaliseUrl = function (url) {
    // normalise youtube urls to the /watch?v= format (t param is replaced with start, v always comes first)
    const youtubeRegex = /(https?:\/\/)?(?:m\.|www\.)?(youtu\.be|youtube\.com)\/(embed\/|v\/|watch\?v=|watch\?.+&v=|shorts\/)?((\w|-){11})(?:\S+)?/;

    if (youtubeRegex.test(url)) {
        const urlObj = new URL(url);
        const params = new URLSearchParams(urlObj.search);
        let start = -1;

        if (params.has("t") || params.has("start")) {
            let startParam = params.get("start"); // start takes precedence over t
            if (!startParam) startParam = params.get("t");
            if (startParam &&
                startParam.match(/^(?:(\d+h)?(\d+m)?(\d+s)?(\d+)?)?$/)
            ) {
                start = 0;
                const hours = startParam.match(/(\d+)h/);
                const minutes = startParam.match(/(\d+)m/);
                const seconds = startParam.match(/(\d+)s/);
                const unqualifiedSeconds = startParam.match(/(\d+)$/);
                if (hours) start += parseInt(hours[1]) * 3600;
                if (minutes) start += parseInt(minutes[1]) * 60;
                if (seconds) start += parseInt(seconds[1]);
                if (unqualifiedSeconds) start += parseInt(unqualifiedSeconds[1]);
            }
        }
        url = url.replace(youtubeRegex, "https://www.youtube.com/watch?v=$4" + (start !== -1 ? "&start=" + start : ""));
    }

    const urlObj = new URL(url);
    const domainName = urlObj.hostname;

    // www.x.com, x.com -> www.twitter.com, twitter.com
    if (domainName.endsWith(".x.com") || domainName === "x.com") {
        if (domainName === "x.com") {
            url = url.replace("x.com", "twitter.com");
        } else if (domainName === "www.x.com") {
            url = url.replace("www.x.com", "www.twitter.com");
        }
    }

    return url;
};

const replaceSocialMediaLinks = function (url) {
    // todo remove this, this is just for me to try out
    // some discord embedders for common sites
    // instagram -> ddinstagram
    // twitter -> vxtwitter
    // tiktok -> vxtiktok
    // reddit -> rxddit

    const urlObj = new URL(url);
    const domainName = urlObj.hostname;

    if (settings.store["Show ddinstagram Embeds"]) {
        if (domainName === "instagram.com" || domainName === "www.instagram.com") {
            url = url.replace("instagram.com", "ddinstagram.com");
        }
    }

    if (settings.store["Show vxtwitter Embeds"]) {
        if (domainName === "twitter.com" || domainName === "www.twitter.com") {
            url = url.replace("twitter.com", "vxtwitter.com");
        }
    }

    if (settings.store["Show vxtiktok Embeds"]) {
        if (domainName === "tiktok.com" || domainName === "www.tiktok.com") {
            url = url.replace("tiktok.com", "vxtiktok.com");
        }
    }

    if (settings.store["Show rxddit Embeds"]) {
        if (domainName === "reddit.com" || domainName === "www.reddit.com") {
            url = url.replace("reddit.com", "rxddit.com");
        }
    }

    return url;
};

const unfurlEmbed = async function (originalUrl, url, message) {
    const channel = ChannelStore.getChannel(message.channel_id);

    const convertedEmbeds: any = [];

    const convertEmbed = findByCode(".uniqueId(\"embed_\")");

    const existingEmbeds = message.embeds;

    if (embedCache.has(url)) {
        for (const embed of embedCache.get(url)) {
            // if the message has an embed for the original url, replace it with the new one
            if (existingEmbeds.some((existing: any) => existing.url === originalUrl)) {
                existingEmbeds.splice(existingEmbeds.findIndex((existing: any) => existing.url === embed.url), 1, convertEmbed(channel.id, message.id, embed));
            } else {
                convertedEmbeds.push(convertEmbed(channel.id, message.id, embed));
            }
        }
        updateMessage(message.channel_id, message.id, { embeds: [...existingEmbeds, ...convertedEmbeds] });
        return;
    }

    if (!parseUrl(url)) {
        return;
    }

    RestAPI.post({
        url: Constants.Endpoints.UNFURL_EMBED_URLS,
        body: {
            urls: [url]
        }
    }).catch(e => {
        Toasts.show({ message: "Failed to fetch embed", id: Toasts.genId(), type: Toasts.Type.FAILURE });
        new Logger("ShowMessageEmbeds").error("Failed to fetch embed", e);
    }).then(resp => {
        const { body } = resp;

        if (!body.embeds || body.embeds.length === 0) {
            Toasts.show({ message: "No embeds found", id: Toasts.genId(), type: Toasts.Type.FAILURE });
        }

        const { embeds } = body;

        if (!embeds || embeds.length === 0) return;
        embedCache.set(url, embeds);
        for (const embed of embeds) {
            // if the message has an embed for the original url, replace it with the new one
            if (existingEmbeds.some((existing: any) => existing.url === originalUrl)) {
                existingEmbeds.splice(existingEmbeds.findIndex((existing: any) => existing.url === embed.url), 1, convertEmbed(channel.id, message.id, embed));
            } else {
                convertedEmbeds.push(convertEmbed(channel.id, message.id, embed));
            }
        }

        const newEmbeds = [...existingEmbeds, ...convertedEmbeds];

        // sort embeds in the order their urls appear in the message
        newEmbeds.sort((a: any, b: any) => {
            return message.content.indexOf(a.url) - message.content.indexOf(b.url);
        });

        updateMessage(message.channel_id, message.id, { embeds: newEmbeds });
    });
};

function messageContainsEmbedForUrl(message: any, url: string): boolean {
    return message?.embeds?.some((embed: any) => {
        return embed.url === url;
    });
}

function messageContainsAttachmentForUrl(message: any, url: string): boolean {
    return message?.attachments?.some((attachment: any) => {
        return attachment.url === url;
    });
}
