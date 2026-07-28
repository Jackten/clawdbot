import Testing
@testable import OpenClaw

@MainActor
@Suite struct TalkRealtimeWebRTCSessionTests {
    @Test func pendingAgentWaitErrorIsNotTerminal() {
        let wait = TalkRealtimeWebRTCSession.AgentWaitResponse(
            runId: "run-1",
            status: "timeout",
            startedAt: 1,
            endedAt: nil,
            error: "provider retry pending",
            stopReason: nil,
            timeoutPhase: "provider",
            providerStarted: true,
            pendingError: true)

        #expect(!TalkRealtimeWebRTCSession.isTerminalRunTimeout(wait))
    }

    @Test func completedProviderTimeoutIsTerminal() {
        let wait = TalkRealtimeWebRTCSession.AgentWaitResponse(
            runId: "run-1",
            status: "timeout",
            startedAt: 1,
            endedAt: 2,
            error: "provider timed out",
            stopReason: "timeout",
            timeoutPhase: "provider",
            providerStarted: true,
            pendingError: false)

        #expect(TalkRealtimeWebRTCSession.isTerminalRunTimeout(wait))
    }
}
