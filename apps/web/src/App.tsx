import { BrowserRouter, Navigate, Route, Routes } from "react-router";
import { Layout } from "./components/Layout.tsx";
import { Spinner } from "./components/ui.tsx";
import { EventsProvider } from "./hooks/events.tsx";
import { SessionProvider, useSession } from "./hooks/session.tsx";
import { LibraryPage } from "./pages/LibraryPage.tsx";
import { LoginPage } from "./pages/LoginPage.tsx";
import { UploadPage } from "./pages/UploadPage.tsx";
import { VideoPage } from "./pages/VideoPage.tsx";

export function App() {
  return (
    <SessionProvider>
      <BrowserRouter>
        <Gate />
      </BrowserRouter>
    </SessionProvider>
  );
}

/** Shows the login screen until there's a session, then the app. */
function Gate() {
  const { session } = useSession();

  if (session.status === "loading") {
    return (
      <div style={{ display: "grid", placeItems: "center", minHeight: "100vh" }}>
        <Spinner />
      </div>
    );
  }
  if (session.status === "anonymous") return <LoginPage />;

  // The event stream is opened only once logged in: it's authorised by the cookie.
  return (
    <EventsProvider>
      <Routes>
        <Route element={<Layout username={session.username} />}>
          <Route index element={<LibraryPage />} />
          <Route path="upload" element={<UploadPage />} />
          <Route path="videos/:videoId" element={<VideoPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </EventsProvider>
  );
}
