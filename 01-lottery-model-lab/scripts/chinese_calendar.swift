#!/usr/bin/env swift

import Foundation

let input = FileHandle.standardInput.readDataToEndOfFile()
guard let text = String(data: input, encoding: .utf8) else {
    fputs("stdin is not valid UTF-8\n", stderr)
    exit(1)
}

let formatter = DateFormatter()
formatter.calendar = Calendar(identifier: .gregorian)
formatter.locale = Locale(identifier: "en_US_POSIX")
formatter.timeZone = TimeZone(identifier: "Asia/Shanghai")
formatter.dateFormat = "yyyy-MM-dd"

var chinese = Calendar(identifier: .chinese)
chinese.timeZone = TimeZone(identifier: "Asia/Shanghai")!

for rawLine in text.split(whereSeparator: \.isNewline) {
    let line = String(rawLine).trimmingCharacters(in: .whitespacesAndNewlines)
    if line.isEmpty { continue }
    guard let date = formatter.date(from: line) else {
        fputs("invalid date: \(line)\n", stderr)
        exit(2)
    }
    let parts = chinese.dateComponents([.year, .month, .day, .isLeapMonth], from: date)
    guard let year = parts.year, let month = parts.month, let day = parts.day else {
        fputs("failed to convert date: \(line)\n", stderr)
        exit(3)
    }
    let leap = parts.isLeapMonth == true ? 1 : 0
    print("\(line),\(year),\(month),\(day),\(leap)")
}
