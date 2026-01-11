import { useState } from "react";
import "./styles/base.css";
import "./styles/buttons.css";
import "./styles/sidebar.css";
import "./styles/home.css";
import "./styles/main.css";
import "./styles/messages.css";
import "./styles/approvals.css";
import "./styles/composer.css";
import "./styles/diff.css";
import { Sidebar } from "./components/Sidebar";
import { Home } from "./components/Home";
import { MainHeader } from "./components/MainHeader";
import { Messages } from "./components/Messages";
import { Approvals } from "./components/Approvals";
import { Composer } from "./components/Composer";
import { GitDiffPanel } from "./components/GitDiffPanel";
import { useWorkspaces } from "./hooks/useWorkspaces";
import { useThreads } from "./hooks/useThreads";
import { useWindowDrag } from "./hooks/useWindowDrag";
import { useGitStatus } from "./hooks/useGitStatus";

function App() {
  const [input, setInput] = useState("");
  const {
    workspaces,
    activeWorkspace,
    activeWorkspaceId,
    setActiveWorkspaceId,
    addWorkspace,
    connectWorkspace,
    markWorkspaceConnected,
  } = useWorkspaces();

  const {
    setActiveThreadId,
    activeMessages,
    approvals,
    startThread,
    sendUserMessage,
    handleApprovalDecision,
  } = useThreads({
    activeWorkspace,
    onWorkspaceConnected: markWorkspaceConnected,
  });

  const gitStatus = useGitStatus(activeWorkspace);

  useWindowDrag("titlebar");

  async function handleOpenProject() {
    const workspace = await addWorkspace();
    if (workspace) {
      setActiveThreadId(null);
    }
  }

  async function handleAddWorkspace() {
    const workspace = await addWorkspace();
    if (workspace) {
      setActiveThreadId(null);
    }
  }

  async function handleNewThread() {
    await startThread();
  }

  async function handleSend() {
    if (!input.trim()) {
      return;
    }
    await sendUserMessage(input);
    setInput("");
  }

  return (
    <div className="app">
      <div className="drag-strip" id="titlebar" />
      <Sidebar
        workspaces={workspaces}
        activeWorkspaceId={activeWorkspaceId}
        onAddWorkspace={handleAddWorkspace}
        onSelectWorkspace={setActiveWorkspaceId}
        onConnectWorkspace={connectWorkspace}
        onAddAgent={() => {}}
      />

      <section className="main">
        {!activeWorkspace && (
          <Home
            onOpenProject={handleOpenProject}
            onAddWorkspace={handleAddWorkspace}
            onCloneRepository={() => {}}
          />
        )}

      {activeWorkspace && (
          <>
            <div className="main-topbar">
              <MainHeader
                workspace={activeWorkspace}
                branchName={gitStatus.branchName || "unknown"}
              />
              <div className="actions">
                <button className="secondary" onClick={handleNewThread}>
                  New thread
                </button>
              </div>
            </div>

            <div className="content">
              <Messages messages={activeMessages} />
            </div>

            <div className="right-panel">
              <GitDiffPanel
                branchName={gitStatus.branchName || "unknown"}
                totalAdditions={gitStatus.totalAdditions}
                totalDeletions={gitStatus.totalDeletions}
                error={gitStatus.error}
                files={gitStatus.files}
              />
              <Approvals approvals={approvals} onDecision={handleApprovalDecision} />
            </div>

            <Composer value={input} onChange={setInput} onSend={handleSend} />
          </>
        )}
      </section>
    </div>
  );
}

export default App;
