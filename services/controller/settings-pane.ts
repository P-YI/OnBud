// System Settings panes (2026-11-09): "설정 앱의 VPN 항목 열어줘", "와이파이 설정 열어줘", "open Bluetooth settings"
// open that pane directly (x-apple.systempreferences:<extension id>). Only the panes below; ids checked against the
// extensions installed on this Mac, so a pane a macOS version lacks falls back to System Settings itself.
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";

export interface Pane { id: string; appex: string; ko: string; en: string }
const P = (re: RegExp, id: string, appex: string, ko: string, en: string) => ({ re, pane: { id, appex, ko, en } });
// Order matters: more specific names first ("화면 기록" before "화면", "잠금 화면" before "화면").
const PANES: { re: RegExp; pane: Pane }[] = [
  P(/\bvpn\b|브이피엔/i, "com.apple.NetworkExtensionSettingsUI.NESettingsUIExtension", "VPN", "VPN", "VPN"),
  P(/와이\s?파이|wi-?fi|무선\s?(랜|네트워크)/i, "com.apple.wifi-settings-extension", "Wi-Fi", "Wi-Fi", "Wi-Fi"),
  P(/블루투스|bluetooth/i, "com.apple.BluetoothSettings", "Bluetooth", "Bluetooth", "Bluetooth"),
  P(/네트워크|network|방화벽|firewall/i, "com.apple.Network-Settings.extension", "Network", "네트워크", "Network"),
  P(/알림|notifications?/i, "com.apple.Notifications-Settings.extension", "NotificationsSettings", "알림", "Notifications"),
  P(/사운드|소리|음향|sound|스피커|speaker|마이크|microphone/i, "com.apple.Sound-Settings.extension", "Sound", "사운드", "Sound"),
  P(/집중\s?모드|방해\s?금지|\bfocus\b|do not disturb/i, "com.apple.Focus-Settings.extension", "FocusSettingsExtension", "집중 모드", "Focus"),
  P(/스크린\s?타임|screen time/i, "com.apple.Screen-Time-Settings.extension", "ScreenTimePreferencesExtension", "스크린 타임", "Screen Time"),
  P(/소프트웨어\s?업데이트|software update|(macos|os)\s?업데이트/i, "com.apple.Software-Update-Settings.extension", "SoftwareUpdateSettingsExtension", "소프트웨어 업데이트", "Software Update"),
  P(/저장\s?공간|스토리지|storage/i, "com.apple.settings.Storage", "Storage", "저장 공간", "Storage"),
  P(/로그인\s?항목|login items?/i, "com.apple.LoginItems-Settings.extension", "LoginItems", "로그인 항목", "Login Items"),
  P(/잠금\s?화면|lock screen/i, "com.apple.Lock-Screen-Settings.extension", "LockScreen", "잠금 화면", "Lock Screen"),
  P(/개인\s?정보|보안|privacy|security|화면\s?기록|screen recording|손쉬운\s?사용\s?권한|전체\s?디스크/i, "com.apple.settings.PrivacySecurity.extension", "SecurityPrivacyExtension", "개인정보 보호 및 보안", "Privacy & Security"),
  P(/손쉬운\s?사용|접근성|accessibility/i, "com.apple.Accessibility-Settings.extension", "AccessibilitySettingsExtension", "손쉬운 사용", "Accessibility"),
  P(/화면\s?모드|모양|appearance|다크\s?모드|dark mode|라이트\s?모드|light mode/i, "com.apple.Appearance-Settings.extension", "Appearance", "화면 모드", "Appearance"),
  P(/제어\s?센터|control center|메뉴\s?막대|menu bar/i, "com.apple.ControlCenter-Settings.extension", "ControlCenterSettings", "제어 센터", "Control Center"),
  P(/\bsiri\b|시리|apple intelligence/i, "com.apple.Siri-Settings.extension", "SiriPreferenceExtension", "Siri", "Siri"),
  P(/스포트라이트|spotlight/i, "com.apple.Spotlight-Settings.extension", "SpotlightPreferenceExtension", "Spotlight", "Spotlight"),
  P(/데스크탑|데스크톱|\bdock\b|desktop/i, "com.apple.Desktop-Settings.extension", "DesktopSettings", "데스크탑 및 Dock", "Desktop & Dock"),
  P(/디스플레이|모니터|해상도|display|monitor|resolution|밝기|brightness/i, "com.apple.Displays-Settings.extension", "DisplaysExt", "디스플레이", "Displays"),
  P(/배경\s?화면|wallpaper/i, "com.apple.Wallpaper-Settings.extension", "Wallpaper", "배경화면", "Wallpaper"),
  P(/배터리|battery|에너지|energy|전원|power/i, "com.apple.Battery-Settings.extension", "PowerPreferences", "배터리", "Battery"),
  P(/touch\s?id|터치\s?아이디|지문|암호|비밀번호 설정|password/i, "com.apple.Touch-ID-Settings.extension", "Touch ID & Password", "Touch ID 및 암호", "Touch ID & Password"),
  P(/사용자|그룹|users?\s?(&|and)?\s?groups?/i, "com.apple.Users-Groups-Settings.extension", "UsersGroups", "사용자 및 그룹", "Users & Groups"),
  P(/인터넷\s?계정|internet accounts?|메일\s?계정/i, "com.apple.Internet-Accounts-Settings.extension", "InternetAccountsSettingsExtension", "인터넷 계정", "Internet Accounts"),
  P(/키보드|keyboard|입력\s?소스|input sources?|단축키|shortcuts? keys?/i, "com.apple.Keyboard-Settings.extension", "KeyboardSettings", "키보드", "Keyboard"),
  P(/트랙패드|trackpad/i, "com.apple.Trackpad-Settings.extension", "TrackpadExtension", "트랙패드", "Trackpad"),
  P(/마우스|mouse/i, "com.apple.Mouse-Settings.extension", "MouseExtension", "마우스", "Mouse"),
  P(/프린터|스캐너|printers?|scanners?/i, "com.apple.Print-Scan-Settings.extension", "PrinterScannerSettings", "프린터 및 스캐너", "Printers & Scanners"),
  P(/날짜|시간대|날짜\s?(및|와)?\s?시간|\bdate\b|time zone/i, "com.apple.Date-Time-Settings.extension", "DateAndTime Extension", "날짜 및 시간", "Date & Time"),
  P(/공유|sharing|airplay|에어플레이|원격\s?로그인|remote login/i, "com.apple.Sharing-Settings.extension", "Sharing", "공유", "Sharing"),
  P(/타임\s?머신|time machine|백업|backup/i, "com.apple.Time-Machine-Settings.extension", "TimeMachineSettings", "Time Machine", "Time Machine"),
  P(/언어|지역|language|region/i, "com.apple.Localization-Settings.extension", "Localization", "언어 및 지역", "Language & Region"),
  P(/apple\s?(id|계정|account)|icloud|아이클라우드/i, "com.apple.systempreferences.AppleIDSettings", "AppleIDSettings", "Apple 계정", "Apple Account"),
  P(/에어드롭|airdrop|handoff|핸드오프/i, "com.apple.AirDrop-Handoff-Settings.extension", "AirDropHandoffExtension", "AirDrop 및 Handoff", "AirDrop & Handoff"),
  P(/일반|general|정보|about this mac/i, "com.apple.systempreferences.GeneralSettings", "GeneralSettings", "일반", "General"),
];

const SETTINGS_WORD = /(시스템\s?설정|시스템\s?환경\s?설정|설정\s?앱|설정|환경\s?설정|system settings|system preferences|settings|preferences)/i;
const OPEN_VERB = /(열어|띄워|보여|가\s?줘|이동|들어가|켜\s?줘|\bopen\b|\bshow\b|\bgo to\b|\btake me\b|\bbring up\b)/i;
// another app's settings ("VS Code 설정", "Chrome settings") is not System Settings
const OTHER_APP = /(vs\s?code|cursor|chrome|크롬|safari|사파리|slack|슬랙|xcode|opencode|codex|copilot|onbud|spotlight 앱|브라우저|browser|터미널|terminal|iterm|ghostty|zed|notion|노션|카카오|kakao)\s?(의\s?)?(설정|settings|preferences)/i;

/** The System Settings pane a request asks to open; `pane` undefined = settings named but no known pane. */
export function settingsPaneIntent(prompt: string): { pane?: Pane } | undefined {
  const p = prompt.trim();
  if (p.length > 80 || !SETTINGS_WORD.test(p) || !OPEN_VERB.test(p) || OTHER_APP.test(p)) return undefined;
  if (/(방법|어떻게|how (do|to|can)|사용법)/i.test(p)) return undefined;
  // changing a setting ("다크 모드 켜줘", "와이파이 꺼줘") is not opening a pane: only "켜줘" with the settings word
  const rest = p.replace(SETTINGS_WORD, " ");
  for (const { re, pane } of PANES) if (re.test(rest)) return { pane };
  // "설정 앱 열어줘" alone is launch_app's (opens System Settings); a named but unknown pane is ours
  return /(항목|메뉴|섹션|탭|패널|화면|페이지|pane|panel|section|tab|page)/i.test(p) ? {} : undefined;
}

export function paneInstalled(p: Pane): boolean {
  return existsSync(`/System/Library/ExtensionKit/Extensions/${p.appex}.appex`);
}

const open = (url: string) => new Promise<boolean>((res) => execFile("/usr/bin/open", [url], { timeout: 10_000 }, (e) => res(!e)));

/** "와이파이 비밀번호 알려줘": the password is in the Keychain, shown only after Touch ID; open the Wi-Fi pane and say where. */
export const WIFI_PASSWORD = /(와이\s?파이|wi-?fi|무선\s?랜).{0,12}(비밀\s?번호|비번|암호|password)/i;

export async function openSettingsPane(prompt: string, ko: boolean, opener = open): Promise<{ answer: string; verified: boolean; detail: string }> {
  if (WIFI_PASSWORD.test(prompt)) {
    const ok = await opener("x-apple.systempreferences:com.apple.wifi-settings-extension");
    return { verified: ok, detail: "wifi_password",
      answer: ko ? `Wi-Fi 비밀번호는 키체인에 있어서 제가 직접 읽지 않아요.${ok ? " **시스템 설정 › Wi-Fi**를 열었어요." : ""}\n\n연결된 네트워크 옆 **ⓘ → 암호 복사** (또는 \"…\" 메뉴 → 암호 복사)를 누르고 Touch ID로 확인하면 클립보드에 복사돼요.`
        : `Wi-Fi passwords are in the Keychain, so I don't read them.${ok ? " Opened **System Settings › Wi-Fi**." : ""}\n\nClick **ⓘ → Copy Password** next to the network (or the "…" menu → Copy Password) and confirm with Touch ID; it goes to the clipboard.` };
  }
  const it = settingsPaneIntent(prompt);
  const pane = it?.pane && paneInstalled(it.pane) ? it.pane : undefined;
  if (!pane) {
    const ok = await opener("x-apple.systempreferences:");
    return { verified: ok, detail: it?.pane ? `pane_missing ${it.pane.en}` : "pane_unknown",
      answer: ok ? (ko ? "해당 항목을 찾지 못해 **시스템 설정**만 열었어요. 왼쪽 검색창에서 항목 이름을 입력해 보세요." : "Could not find that pane, so I opened **System Settings**; type the pane's name in its search field.")
        : (ko ? "시스템 설정을 열지 못했어요." : "Could not open System Settings.") };
  }
  const ok = await opener(`x-apple.systempreferences:${pane.id}`);
  return { verified: ok, detail: `pane ${pane.en}`,
    answer: ok ? (ko ? `**시스템 설정 › ${pane.ko}**을(를) 열었어요.` : `Opened **System Settings › ${pane.en}**.`)
      : (ko ? `시스템 설정의 ${pane.ko} 항목을 열지 못했어요.` : `Could not open System Settings › ${pane.en}.`) };
}
