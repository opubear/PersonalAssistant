import Testing
import Foundation
import CoreGraphics
@testable import QiyiMacOS

struct WindowSelectionTests {
    private let bounds = CGRect(x: -1200, y: 30, width: 900, height: 700)

    private func candidate(
        _ id: UInt32, pid: Int32 = 42, frame: CGRect? = nil, title: String = "Editor"
    ) -> WindowCandidate {
        WindowCandidate(id: id, processID: pid, frame: frame ?? bounds, title: title)
    }

    @Test func selectsFocusedGeometryInsteadOfFirstWindowOrOtherApplication() throws {
        let windows = [
            candidate(1, pid: 77),
            candidate(2, frame: bounds.offsetBy(dx: 400, dy: 0)),
            candidate(3),
        ]
        let id = try WindowSelection.select(
            processID: 42, frame: bounds, title: "Editor", candidates: windows
        )
        #expect(id == 3)
    }

    @Test func toleratesRoundingAndNegativeDisplayCoordinates() throws {
        let id = try WindowSelection.select(
            processID: 42, frame: bounds.offsetBy(dx: 1, dy: -1), title: "",
            candidates: [candidate(1, title: "")]
        )
        #expect(id == 1)
    }

    @Test func titleDisambiguatesOverlappingWindows() throws {
        let id = try WindowSelection.select(
            processID: 42, frame: bounds, title: "Second",
            candidates: [candidate(1), candidate(2, title: "Second")]
        )
        #expect(id == 2)
    }

    @Test func ambiguousWindowFailsInsteadOfCapturingArbitraryWindow() {
        #expect(throws: WindowSelectionError.ambiguous) {
            try WindowSelection.select(
                processID: 42, frame: bounds, title: "Editor",
                candidates: [candidate(1), candidate(2)]
            )
        }
    }

    @Test func missingWindowNeverFallsBackToAnotherWindow() {
        #expect(throws: WindowSelectionError.notFound) {
            try WindowSelection.select(
                processID: 42, frame: bounds, title: "Editor", candidates: [candidate(1, pid: 77)]
            )
        }
    }

}
