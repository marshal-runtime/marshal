import {
  ArrowBendUpLeft as PhosphorArrowBendUpLeft,
  ArrowCounterClockwise as PhosphorArrowCounterClockwise,
  ArrowDown as PhosphorArrowDown,
  ArrowLeft as PhosphorArrowLeft,
  ArrowLineDown as PhosphorArrowLineDown,
  ArrowSquareOut as PhosphorArrowSquareOut,
  ArrowUp as PhosphorArrowUp,
  ArrowsClockwise as PhosphorArrowsClockwise,
  Buildings as PhosphorBuildings,
  CalendarDots as PhosphorCalendarDots,
  Camera as PhosphorCamera,
  CaretDown as PhosphorCaretDown,
  CaretLeft as PhosphorCaretLeft,
  CaretRight as PhosphorCaretRight,
  CaretUp as PhosphorCaretUp,
  CaretUpDown as PhosphorCaretUpDown,
  ChatCenteredDots as PhosphorChatCenteredDots,
  ChatCenteredText as PhosphorChatCenteredText,
  ChatCircleDots as PhosphorChatCircleDots,
  Check as PhosphorCheck,
  CheckCircle as PhosphorCheckCircle,
  Circle as PhosphorCircle,
  CircleDashed as PhosphorCircleDashed,
  CircleNotch as PhosphorCircleNotch,
  ClipboardText as PhosphorClipboardText,
  Clock as PhosphorClock,
  ClockCounterClockwise as PhosphorClockCounterClockwise,
  CloudArrowUp as PhosphorCloudArrowUp,
  CloudSlash as PhosphorCloudSlash,
  Code as PhosphorCode,
  Copy as PhosphorCopy,
  CornersIn as PhosphorCornersIn,
  CornersOut as PhosphorCornersOut,
  DotsSixVertical as PhosphorDotsSixVertical,
  DotsThree as PhosphorDotsThree,
  DownloadSimple as PhosphorDownloadSimple,
  Envelope as PhosphorEnvelope,
  Eye as PhosphorEye,
  AddressBook as PhosphorAddressBook,
  Database as PhosphorDatabase,
  File as PhosphorFile,
  FileArrowUp as PhosphorFileArrowUp,
  FileAudio as PhosphorFileAudio,
  FileCloud as PhosphorFileCloud,
  FileCode as PhosphorFileCode,
  FileCsv as PhosphorFileCsv,
  FileDoc as PhosphorFileDoc,
  FileHtml as PhosphorFileHtml,
  FileJpg as PhosphorFileJpg,
  FilePdf as PhosphorFilePdf,
  FilePlus as PhosphorFilePlus,
  FilePpt as PhosphorFilePpt,
  FileText as PhosphorFileText,
  FileVideo as PhosphorFileVideo,
  FileXls as PhosphorFileXls,
  PenNib as PhosphorPenNib,
  Flag as PhosphorFlag,
  FloppyDisk as PhosphorFloppyDisk,
  Folder as PhosphorFolder,
  FolderOpen as PhosphorFolderOpen,
  FolderPlus as PhosphorFolderPlus,
  FolderSimple as PhosphorFolderSimple,
  FunnelSimple as PhosphorFunnelSimple,
  GearSix as PhosphorGearSix,
  GitBranch as PhosphorGitBranch,
  GitDiff as PhosphorGitDiff,
  Globe as PhosphorGlobe,
  Image as PhosphorImage,
  Info as PhosphorInfo,
  Key as PhosphorKey,
  Lightbulb as PhosphorLightbulb,
  Lightning as PhosphorLightning,
  Link as PhosphorLink,
  LinkBreak as PhosphorLinkBreak,
  ListBullets as PhosphorListBullets,
  ListChecks as PhosphorListChecks,
  ListNumbers as PhosphorListNumbers,
  Lock as PhosphorLock,
  MagnifyingGlass as PhosphorMagnifyingGlass,
  Microphone as PhosphorMicrophone,
  Minus as PhosphorMinus,
  Monitor as PhosphorMonitor,
  NotePencil as PhosphorNotePencil,
  Package as PhosphorPackage,
  PaperPlaneTilt as PhosphorPaperPlaneTilt,
  Paperclip as PhosphorPaperclip,
  Pause as PhosphorPause,
  PencilRuler as PhosphorPencilRuler,
  PencilSimple as PhosphorPencilSimple,
  PencilSimpleLine as PhosphorPencilSimpleLine,
  Play as PhosphorPlay,
  PlayCircle as PhosphorPlayCircle,
  Plug as PhosphorPlug,
  PlugCharging as PhosphorPlugCharging,
  Plus as PhosphorPlus,
  Prohibit as PhosphorProhibit,
  PuzzlePiece as PhosphorPuzzlePiece,
  Question as PhosphorQuestion,
  Quotes as PhosphorQuotes,
  Robot as PhosphorRobot,
  RocketLaunch as PhosphorRocketLaunch,
  ShieldCheck as PhosphorShieldCheck,
  ShieldWarning as PhosphorShieldWarning,
  Sidebar as PhosphorSidebar,
  SidebarSimple as PhosphorSidebarSimple,
  SignIn as PhosphorSignIn,
  SignOut as PhosphorSignOut,
  SlidersHorizontal as PhosphorSlidersHorizontal,
  Sparkle as PhosphorSparkle,
  Square as PhosphorSquare,
  SquareHalfBottom as PhosphorSquareHalfBottom,
  Table as PhosphorTable,
  Target as PhosphorTarget,
  Terminal as PhosphorTerminal,
  TextHOne as PhosphorTextHOne,
  TextHThree as PhosphorTextHThree,
  TextHTwo as PhosphorTextHTwo,
  Trash as PhosphorTrash,
  User as PhosphorUser,
  Warning as PhosphorWarning,
  WarningCircle as PhosphorWarningCircle,
  Wrench as PhosphorWrench,
  X as PhosphorX,
  XCircle as PhosphorXCircle,
  type Icon,
  type IconWeight,
} from "@phosphor-icons/react";
/* eslint-disable react/only-export-components -- central icon compatibility barrel creates wrapped components */
import {
  forwardRef,
  type ComponentPropsWithoutRef,
  type ForwardRefExoticComponent,
  type RefAttributes,
} from "react";

export interface MarshalIconProps extends ComponentPropsWithoutRef<"svg"> {
  absoluteStrokeWidth?: boolean;
  alt?: string;
  color?: string;
  mirrored?: boolean;
  size?: number | string;
  weight?: IconWeight;
}

export type MarshalIcon = ForwardRefExoticComponent<
  MarshalIconProps & RefAttributes<SVGSVGElement>
>;

type IconOptions = {
  mirrored?: boolean;
};

function createMarshalIcon(
  IconComponent: Icon,
  displayName: string,
  options: IconOptions = {},
): MarshalIcon {
  const Component = forwardRef<SVGSVGElement, MarshalIconProps>(
    (
      {
        absoluteStrokeWidth: _absoluteStrokeWidth,
        mirrored,
        strokeWidth: _strokeWidth,
        weight = "regular",
        ...props
      },
      ref,
    ) => (
      <IconComponent ref={ref} mirrored={options.mirrored ?? mirrored} weight={weight} {...props} />
    ),
  );
  Component.displayName = displayName;
  return Component;
}

export const AddressBook = createMarshalIcon(PhosphorAddressBook, "AddressBook");
export const AlertCircle = createMarshalIcon(PhosphorWarningCircle, "AlertCircle");
export const AlertTriangle = createMarshalIcon(PhosphorWarning, "AlertTriangle");
export const ArrowDown = createMarshalIcon(PhosphorArrowDown, "ArrowDown");
export const ArrowDownToLine = createMarshalIcon(PhosphorArrowLineDown, "ArrowDownToLine");
export const ArrowLeft = createMarshalIcon(PhosphorArrowLeft, "ArrowLeft");
export const ArrowUp = createMarshalIcon(PhosphorArrowUp, "ArrowUp");
export const Bot = createMarshalIcon(PhosphorRobot, "Bot");
export const Building2 = createMarshalIcon(PhosphorBuildings, "Building2");
export const CalendarClock = createMarshalIcon(PhosphorCalendarDots, "CalendarClock");
export const Camera = createMarshalIcon(PhosphorCamera, "Camera");
export const Check = createMarshalIcon(PhosphorCheck, "Check");
export const CheckCircle2 = createMarshalIcon(PhosphorCheckCircle, "CheckCircle2");
export const CheckIcon = createMarshalIcon(PhosphorCheck, "CheckIcon");
export const ChevronDown = createMarshalIcon(PhosphorCaretDown, "ChevronDown");
export const ChevronDownIcon = createMarshalIcon(PhosphorCaretDown, "ChevronDownIcon");
export const ChevronLeft = createMarshalIcon(PhosphorCaretLeft, "ChevronLeft");
export const ChevronRight = createMarshalIcon(PhosphorCaretRight, "ChevronRight");
export const ChevronRightIcon = createMarshalIcon(PhosphorCaretRight, "ChevronRightIcon");
export const ChevronsUpDown = createMarshalIcon(PhosphorCaretUpDown, "ChevronsUpDown");
export const ChevronUp = createMarshalIcon(PhosphorCaretUp, "ChevronUp");
export const ChevronUpIcon = createMarshalIcon(PhosphorCaretUp, "ChevronUpIcon");
export const Circle = createMarshalIcon(PhosphorCircle, "Circle");
export const CircleAlert = createMarshalIcon(PhosphorWarningCircle, "CircleAlert");
export const CircleCheck = createMarshalIcon(PhosphorCheckCircle, "CircleCheck");
export const CircleCheckIcon = createMarshalIcon(PhosphorCheckCircle, "CircleCheckIcon");
export const CircleDashed = createMarshalIcon(PhosphorCircleDashed, "CircleDashed");
export const CircleSlash = createMarshalIcon(PhosphorProhibit, "CircleSlash");
export const CircleX = createMarshalIcon(PhosphorXCircle, "CircleX");
export const ClipboardList = createMarshalIcon(PhosphorClipboardText, "ClipboardList");
export const Clock = createMarshalIcon(PhosphorClock, "Clock");
export const CloudOff = createMarshalIcon(PhosphorCloudSlash, "CloudOff");
export const CloudUpload = createMarshalIcon(PhosphorCloudArrowUp, "CloudUpload");
export const Code = createMarshalIcon(PhosphorCode, "Code");
export const Copy = createMarshalIcon(PhosphorCopy, "Copy");
export const Database = createMarshalIcon(PhosphorDatabase, "Database");
export const Download = createMarshalIcon(PhosphorDownloadSimple, "Download");
export const Ellipsis = createMarshalIcon(PhosphorDotsThree, "Ellipsis");
export const ExternalLink = createMarshalIcon(PhosphorArrowSquareOut, "ExternalLink");
export const Eye = createMarshalIcon(PhosphorEye, "Eye");
export const File = createMarshalIcon(PhosphorFile, "File");
export const FileAudio = createMarshalIcon(PhosphorFileAudio, "FileAudio");
export const FileCloud = createMarshalIcon(PhosphorFileCloud, "FileCloud");
export const FileCode = createMarshalIcon(PhosphorFileCode, "FileCode");
export const FileCsv = createMarshalIcon(PhosphorFileCsv, "FileCsv");
export const FileDiff = createMarshalIcon(PhosphorGitDiff, "FileDiff");
export const FileDoc = createMarshalIcon(PhosphorFileDoc, "FileDoc");
export const FileEdit = createMarshalIcon(PhosphorNotePencil, "FileEdit");
export const FileHtml = createMarshalIcon(PhosphorFileHtml, "FileHtml");
export const FileJpg = createMarshalIcon(PhosphorFileJpg, "FileJpg");
export const FilePdf = createMarshalIcon(PhosphorFilePdf, "FilePdf");
export const FilePlus = createMarshalIcon(PhosphorFilePlus, "FilePlus");
export const FilePpt = createMarshalIcon(PhosphorFilePpt, "FilePpt");
export const FileText = createMarshalIcon(PhosphorFileText, "FileText");
export const FileUp = createMarshalIcon(PhosphorFileArrowUp, "FileUp");
export const FileVideo = createMarshalIcon(PhosphorFileVideo, "FileVideo");
export const FileXls = createMarshalIcon(PhosphorFileXls, "FileXls");
export const FileXml = createMarshalIcon(PhosphorFileCode, "FileXml");
export const Flag = createMarshalIcon(PhosphorFlag, "Flag");
export const Folder = createMarshalIcon(PhosphorFolder, "Folder");
export const FolderCog = createMarshalIcon(PhosphorFolderSimple, "FolderCog");
export const FolderGit2 = createMarshalIcon(PhosphorGitBranch, "FolderGit2");
export const FolderOpen = createMarshalIcon(PhosphorFolderOpen, "FolderOpen");
export const FolderPlus = createMarshalIcon(PhosphorFolderPlus, "FolderPlus");
export const Globe = createMarshalIcon(PhosphorGlobe, "Globe");
export const GripVertical = createMarshalIcon(PhosphorDotsSixVertical, "GripVertical");
export const Heading1 = createMarshalIcon(PhosphorTextHOne, "Heading1");
export const Heading2 = createMarshalIcon(PhosphorTextHTwo, "Heading2");
export const Heading3 = createMarshalIcon(PhosphorTextHThree, "Heading3");
export const HelpCircle = createMarshalIcon(PhosphorQuestion, "HelpCircle");
export const History = createMarshalIcon(PhosphorClockCounterClockwise, "History");
export const Image = createMarshalIcon(PhosphorImage, "Image");
export const Info = createMarshalIcon(PhosphorInfo, "Info");
export const InfoIcon = createMarshalIcon(PhosphorInfo, "InfoIcon");
export const KeyRound = createMarshalIcon(PhosphorKey, "KeyRound");
export const Lightbulb = createMarshalIcon(PhosphorLightbulb, "Lightbulb");
export const Link = createMarshalIcon(PhosphorLink, "Link");
export const Link2Off = createMarshalIcon(PhosphorLinkBreak, "Link2Off");
export const List = createMarshalIcon(PhosphorListBullets, "List");
export const ListFilter = createMarshalIcon(PhosphorFunnelSimple, "ListFilter");
export const ListOrdered = createMarshalIcon(PhosphorListNumbers, "ListOrdered");
export const ListTodo = createMarshalIcon(PhosphorListChecks, "ListTodo");
export const Loader = createMarshalIcon(PhosphorCircleNotch, "Loader");
export const Loader2 = createMarshalIcon(PhosphorCircleNotch, "Loader2");
export const Loader2Icon = createMarshalIcon(PhosphorCircleNotch, "Loader2Icon");
export const LoaderCircle = createMarshalIcon(PhosphorCircleNotch, "LoaderCircle");
export const Lock = createMarshalIcon(PhosphorLock, "Lock");
export const LogIn = createMarshalIcon(PhosphorSignIn, "LogIn");
export const LogOut = createMarshalIcon(PhosphorSignOut, "LogOut");
export const Mail = createMarshalIcon(PhosphorEnvelope, "Mail");
export const Maximize2 = createMarshalIcon(PhosphorCornersOut, "Maximize2");
export const MessageCircleWarning = createMarshalIcon(
  PhosphorChatCircleDots,
  "MessageCircleWarning",
);
export const MessageSquare = createMarshalIcon(PhosphorChatCenteredText, "MessageSquare");
export const MessageSquareMore = createMarshalIcon(PhosphorChatCenteredDots, "MessageSquareMore");
export const MessageSquarePlus = createMarshalIcon(PhosphorChatCenteredText, "MessageSquarePlus");
export const Mic = createMarshalIcon(PhosphorMicrophone, "Mic");
export const Minimize2 = createMarshalIcon(PhosphorCornersIn, "Minimize2");
export const Minus = createMarshalIcon(PhosphorMinus, "Minus");
export const MonitorX = createMarshalIcon(PhosphorMonitor, "MonitorX");
export const OctagonXIcon = createMarshalIcon(PhosphorXCircle, "OctagonXIcon");
export const Package = createMarshalIcon(PhosphorPackage, "Package");
export const PanelBottom = createMarshalIcon(PhosphorSquareHalfBottom, "PanelBottom");
export const PanelLeftClose = createMarshalIcon(PhosphorSidebarSimple, "PanelLeftClose");
export const PanelLeftOpen = createMarshalIcon(PhosphorSidebar, "PanelLeftOpen");
export const PanelRightClose = createMarshalIcon(PhosphorSidebarSimple, "PanelRightClose", {
  mirrored: true,
});
export const PanelRightOpen = createMarshalIcon(PhosphorSidebar, "PanelRightOpen", {
  mirrored: true,
});
export const Paperclip = createMarshalIcon(PhosphorPaperclip, "Paperclip");
export const Pause = createMarshalIcon(PhosphorPause, "Pause");
export const PenNib = createMarshalIcon(PhosphorPenNib, "PenNib");
export const Pencil = createMarshalIcon(PhosphorPencilSimple, "Pencil");
export const PencilRuler = createMarshalIcon(PhosphorPencilRuler, "PencilRuler");
export const PenLine = createMarshalIcon(PhosphorPencilSimpleLine, "PenLine");
export const Play = createMarshalIcon(PhosphorPlay, "Play");
export const PlayCircle = createMarshalIcon(PhosphorPlayCircle, "PlayCircle");
export const Plug = createMarshalIcon(PhosphorPlug, "Plug");
export const PlugZap = createMarshalIcon(PhosphorPlugCharging, "PlugZap");
export const Plus = createMarshalIcon(PhosphorPlus, "Plus");
export const Puzzle = createMarshalIcon(PhosphorPuzzlePiece, "Puzzle");
export const RefreshCw = createMarshalIcon(PhosphorArrowsClockwise, "RefreshCw");
export const Reply = createMarshalIcon(PhosphorArrowBendUpLeft, "Reply");
export const Rocket = createMarshalIcon(PhosphorRocketLaunch, "Rocket");
export const RotateCcw = createMarshalIcon(PhosphorArrowCounterClockwise, "RotateCcw");
export const Save = createMarshalIcon(PhosphorFloppyDisk, "Save");
export const Search = createMarshalIcon(PhosphorMagnifyingGlass, "Search");
export const SearchIcon = createMarshalIcon(PhosphorMagnifyingGlass, "SearchIcon");
export const Send = createMarshalIcon(PhosphorPaperPlaneTilt, "Send");
export const Settings = createMarshalIcon(PhosphorGearSix, "Settings");
export const ShieldAlert = createMarshalIcon(PhosphorShieldWarning, "ShieldAlert");
export const ShieldCheck = createMarshalIcon(PhosphorShieldCheck, "ShieldCheck");
export const SlidersHorizontal = createMarshalIcon(PhosphorSlidersHorizontal, "SlidersHorizontal");
export const Sparkles = createMarshalIcon(PhosphorSparkle, "Sparkles");
export const Square = createMarshalIcon(PhosphorSquare, "Square");
export const Table = createMarshalIcon(PhosphorTable, "Table");
export const Target = createMarshalIcon(PhosphorTarget, "Target");
export const Terminal = createMarshalIcon(PhosphorTerminal, "Terminal");
export const TextQuote = createMarshalIcon(PhosphorQuotes, "TextQuote");
export const Trash2 = createMarshalIcon(PhosphorTrash, "Trash2");
export const TriangleAlert = createMarshalIcon(PhosphorWarning, "TriangleAlert");
export const TriangleAlertIcon = createMarshalIcon(PhosphorWarning, "TriangleAlertIcon");
export const User = createMarshalIcon(PhosphorUser, "User");
export const Wrench = createMarshalIcon(PhosphorWrench, "Wrench");
export const X = createMarshalIcon(PhosphorX, "X");
export const XCircle = createMarshalIcon(PhosphorXCircle, "XCircle");
export const XIcon = createMarshalIcon(PhosphorX, "XIcon");
export const Zap = createMarshalIcon(PhosphorLightning, "Zap");
