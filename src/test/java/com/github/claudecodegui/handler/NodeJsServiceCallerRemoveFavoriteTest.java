package com.github.claudecodegui.handler;

import com.github.claudecodegui.testing.SessionMetadataBridgeFixture;
import org.junit.Before;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import java.util.Set;

import static org.junit.Assert.assertEquals;

/**
 * {@code HistoryDeleteService} removes the favorite of a deleted session via
 * {@code removeFavorite}, which the favorites whitelist used to reject, so the
 * entry stayed in favorites.json forever. Runs the real favorites-service.cjs.
 */
public class NodeJsServiceCallerRemoveFavoriteTest {

    @Rule
    public final TemporaryFolder temporaryFolder = new TemporaryFolder();

    private SessionMetadataBridgeFixture fixture;

    @Before
    public void setUp() throws Exception {
        fixture = SessionMetadataBridgeFixture.create(temporaryFolder.getRoot().toPath());
    }

    @Test
    public void removeFavoriteDeletesOnlyTheGivenSession() throws Exception {
        fixture.seedFavorites("session-a", "session-b");

        // removeFavorite logs a "[Favorites] Removed favorite" line first; the
        // caller must still hand back the trailing JSON result line.
        String result = new NodeJsServiceCaller(fixture.context())
                .callNodeJsFavoritesService("removeFavorite", "session-a");

        assertEquals("true", result);
        assertEquals(Set.of("session-b"), fixture.favoriteIds());
        assertEquals(0, fixture.processManager().getActiveProcessCount());
    }

    @Test
    public void removeFavoriteOfUnfavoritedSessionIsANoOp() throws Exception {
        fixture.seedFavorites("session-b");

        String result = new NodeJsServiceCaller(fixture.context())
                .callNodeJsFavoritesService("removeFavorite", "session-a");

        assertEquals("true", result);
        assertEquals(Set.of("session-b"), fixture.favoriteIds());
    }
}
