import { LOG, THROW_DEBUG_ERROR } from "../main";
import Filters, { ProcessLevel } from "../processing";
import Database from "../tools/database";
import Users from "../stores/users";
import Fetch from "./fetch";
import { Playlist } from "../shared/types/playlist";
import FilterTask from "../stores/filtertask";
import { SUser } from "../shared/types/server";

export default class Updater {
    /**
     * Starts a cronjob to update the playlist certain amount of time
     */
    static schedule(){
        // Run the updater every hour
        setInterval(() => Updater.updatePlaylists(), 1000 * 60 * 60);
        // Clean up the database every 4 days
        setInterval(() => Updater.cleanDatabase(), 1000 * 60 * 60 * 24 * 4);
        Updater.cleanDatabase();
    }

    /**
     * Updates all playlists in the database
     */
    static async updatePlaylists() {
        let timer: any;
        let performance: number[] = [];
        const users = await Database.getAllUsers();

        // We process the playlist for each user
        for (const dbuser of users) {
            try {
                /* Get the user and their playlists */
                const playlists = await Database.getUserPlaylists(dbuser.id);
                const user      = await Users.get(dbuser.id)

                /* Sequentially update all playlists. Don't spam Spotify */
                for (const playlist of playlists) {
                    try {
                        const task = new FilterTask(`playlist:${playlist.id}`, ProcessLevel.PLAYLIST);
                        timer = process.hrtime();
                        /** We wait for each playlist to be processed.
                         * This should get faster and faster as more metadata is cached */
                        await Filters.executePlaylist(task, playlist.id, user, true);
                        performance.push(process.hrtime(timer)[1] / 1000000);
                    } catch (e) {
                        LOG(`Something went wrong while updating playlist with id: ${playlist.id}: \n${e}`);
                        LOG(e.stack)
                    }
                }
            } catch (e) {
                LOG(`Something is wrong with user ${dbuser.name} (id: ${dbuser.id}): \n${e}`);
                LOG(e.stack)
            }
        }

        /* Log the performance */
        const date = new Date();
        const total = performance.reduce((a, b) => a + b, 0),
                avg = total / performance.length,
                max = Math.max(...performance);
        LOG(`${date.toISOString()}: Updating playlists performance: \n - total: ${total}ms \n - avg: ${avg}ms \n - max: ${max}ms`);
    }

    /**
     * Cleans the database from playlists which are not in Spotify anymore. This can happen if a user deletes a
     * playlist which also has no followers. We don't want to keep these playlists in our database as this is
     * more computing.
     */
    static async cleanDatabase() {
        const db_users = await Database.getAllUsers();
        const db_playlists = await Database.getAllPlaylists();

        type FollowerCount = {followers: {total: number}};
        type SPPlaylist = Playlist & FollowerCount;
        const sp_remove: SPPlaylist[] = [];

        // For each user
        for (const user of db_users) {
            // Get all playlists from spotify
            const sp_playlist_response = await Fetch.get<SPPlaylist[]>(`/users/${user.id}/playlists`, {
                user: await Users.get(user.id),
                pagination: true
            });

            // Store the playlists for this user
            if (sp_playlist_response.status !== 200) {
                THROW_DEBUG_ERROR(`Cleaning database: failed to get playlists for user_id: ${user.id}. Error: \n${sp_playlist_response}`);
                LOG(`Cleaning database: failed to get playlists for user_id: ${user.id}. Error: \n${sp_playlist_response}`);
            }
            else {
                for (const playlist of sp_playlist_response.data) {
                    // Make sure this is a smart playlist
                    if (!db_playlists.some(p => p.id == playlist.id))
                        continue;

                    const sp_playlist_response = await Fetch.get<FollowerCount>(`/playlists/${playlist.id}`, {
                        user: await Users.get(user.id),
                        query: { fields: 'followers.total' }
                    });

                    // Check how many followers the playlist has
                    if (sp_playlist_response.status !== 200) {
                        THROW_DEBUG_ERROR(`Cleaning database: failed to get follower count for playlist: ${playlist.id}. Error:\n${sp_playlist_response}`);
                        LOG(`Cleaning database: failed to get follower count for playlist: ${playlist.id}. Error:\n${sp_playlist_response}`);
                    }
                    // Check if the playlist has 0 followers
                    else if (sp_playlist_response.status === 200 && sp_playlist_response.data.followers.total == 0) {
                        playlist.followers = { total: sp_playlist_response.data.followers.total }
                        sp_remove.push(playlist)
                    }
                }
            }
        }

        // Remove the playlists
        const users: {[id: string]: string[] | false} = {};
        for (const playlist of sp_remove) {
            const user_id = (playlist as any).owner.id;
            // If we failed to get the user's playlists, we don't want to try again
            if (users[user_id] === false) continue;
            if (users[user_id] === undefined) {
                // Get the user's playlists
                const response = await Fetch.get(`/users/${user_id}/playlists`, {
                    user: await Users.get(user_id),
                    query: { fields: 'items.id' }
                });

                // If we failed to retrieve the user's playlists, we don't want to try again
                if (response.status !== 200) {
                    users[user_id] = false;
                    continue;
                }

                // Store the user's playlists
                users[user_id] = response.data.items.map((p: {id: string}) => p.id);
            }

            // If the playlist does not exist in the owner's playlists, we can delete it
            if (users[user_id] && !users[user_id].includes(playlist.id)) {
                LOG(`Removed playlist ${playlist.name} (${playlist.id}). Attributes: \n - Followers: ${playlist.followers.total}\n - User: ${(playlist as any).owner.display_name}\n - url: https://open.spotify.com/playlist/${playlist.id}\nUser playlists ids:`);
                LOG(users[user_id]);
                LOG(`Playlist object:`);
                LOG(playlist);
                LOG();
                // await Database.deletePlaylist(user_id, playlist.id);
                continue;
            }
        }
    }
}
