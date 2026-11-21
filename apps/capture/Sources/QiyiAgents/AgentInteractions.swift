import Foundation

extension ProcessAgentSession {
    func handlePiInteraction(_ record: [String: Any]) {
        guard let id = record["id"] as? String, let method = record["method"] as? String else { return }
        guard ["confirm", "select", "input", "editor"].contains(method) else { return }
        let options: [AgentInteraction.Choice]
        if method == "confirm" {
            options = [.init(id: "yes", title: "是"), .init(id: "no", title: "否")]
        } else {
            options = (record["options"] as? [String] ?? []).map { .init(id: $0, title: $0) }
        }
        ask(AgentInteraction(
            title: record["title"] as? String ?? "Pi 需要回应",
            detail: record["message"] as? String ?? "",
            choices: options, acceptsText: method == "input" || method == "editor",
            initialText: record["prefill"] as? String ?? ""
        )) { [weak self] answer in
            var response: [String: Any] = ["type": "extension_ui_response", "id": id]
            switch answer {
            case .choice(let value):
                if method == "confirm" { response["confirmed"] = value == "yes" }
                else { response["value"] = value }
            case .text(let value): response["value"] = value
            case .cancelled: response["cancelled"] = true
            }
            self?.send(response)
        }
    }

    func handleServerRequest(_ record: [String: Any]) {
        guard let method = record["method"] as? String, let params = record["params"] as? [String: Any] else { return }
        switch method {
        case "session/request_permission":
            let options = (params["options"] as? [[String: Any]] ?? []).compactMap { option -> AgentInteraction.Choice? in
                guard let id = option["optionId"] as? String, let name = option["name"] as? String else { return nil }
                return .init(id: id, title: name)
            }
            ask(.init(title: "dsh 请求操作权限", detail: Self.describe(permissionDetail(params)), choices: options)) { [weak self] answer in
                if case .choice(let id) = answer, options.contains(where: { $0.id == id }) {
                    self?.reply(to: record, result: ["outcome": ["outcome": "selected", "optionId": id]])
                } else {
                    self?.reply(to: record, result: ["outcome": ["outcome": "cancelled"]])
                }
            }
        case "item/commandExecution/requestApproval", "item/fileChange/requestApproval":
            ask(.init(title: "Codex 请求操作权限", detail: Self.describe(permissionDetail(params)), choices: [
                .init(id: "accept", title: "允许本次"), .init(id: "decline", title: "拒绝本次"),
            ])) { [weak self] answer in
                let decision: String
                if case .choice(let choice) = answer, ["accept", "decline"].contains(choice) { decision = choice }
                else { decision = "cancel" }
                self?.reply(to: record, result: ["decision": decision])
            }
        case "item/tool/requestUserInput":
            let questions = params["questions"] as? [[String: Any]] ?? []
            answerCodexQuestions(questions, answers: [:], record: record)
        default:
            guard let id = record["id"] else { return }
            // Unsupported methods are errors, never implicit permission grants.
            send(["jsonrpc": "2.0", "id": id, "error": ["code": -32601, "message": "Qiyi does not support \(method)"]])
        }
    }

    private func answerCodexQuestions(_ questions: [[String: Any]], answers: [String: Any], record: [String: Any]) {
        guard let question = questions.first, let id = question["id"] as? String else {
            reply(to: record, result: ["answers": answers])
            return
        }
        let options = (question["options"] as? [[String: Any]] ?? []).compactMap { value -> AgentInteraction.Choice? in
            guard let label = value["label"] as? String else { return nil }
            return .init(id: label, title: label + " — " + (value["description"] as? String ?? ""))
        }
        ask(.init(title: "Codex 需要回应", detail: question["question"] as? String ?? "", choices: options, acceptsText: true)) { [weak self] answer in
            var answers = answers
            switch answer {
            case .choice(let text), .text(let text): answers[id] = ["answers": [text]]
            case .cancelled: answers[id] = ["answers": [] as [String]]
            }
            self?.answerCodexQuestions(Array(questions.dropFirst()), answers: answers, record: record)
        }
    }

    private static func describe(_ value: Any) -> String {
        guard let data = try? JSONSerialization.data(withJSONObject: value, options: [.prettyPrinted, .sortedKeys]) else {
            return String(describing: value)
        }
        return String(decoding: data, as: UTF8.self)
    }
}
