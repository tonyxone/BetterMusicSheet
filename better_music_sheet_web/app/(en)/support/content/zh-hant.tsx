import Link from "next/link";
import { BackButton } from "../../../back-button";

export function SupportZhHant({ path }: { path: (p: string) => string }) {
  return (
    <div className="wrap medium legal">
      <div className="page-title-row">
        <BackButton />
        <h1 className="serif">支援</h1>
      </div>
      <div className="sub">最後更新：2026年9月28日</div>

      <h2>聯絡我們</h2>
      <p>
        歡迎將問題、錯誤回報以及辨識出錯的樂譜寄到{" "}
        <a href="mailto:bettermusicsheet@gmail.com">bettermusicsheet@gmail.com</a>
        。請註明你使用的瀏覽器；如果樂譜辨識得不好，請附上該樂譜。
      </p>

      <h2>免費版與進階版</h2>
      <p>
        免費帳號一次保留一份樂譜（要上傳另一份，請先刪除現有的那份），練習模式只播放樂譜的前兩行。
        進階版可以保留任意數量的樂譜，並解鎖完整的練習模式。
      </p>

      <h2>管理或取消訂閱</h2>
      <p>
        在<Link href={path("/subscription")}>訂閱頁面</Link>變更方案或取消訂閱。取消後，進階版會保留到你已付費的期間結束。
      </p>

      <h2>付款後沒有顯示進階版</h2>
      <p>訂閱屬於購買它的帳號，請確認你登入的是那個帳號，然後重新整理頁面。如果仍然沒有顯示，請寄信給我們。</p>

      <h2>獲得最佳效果</h2>
      <p>
        盡量上傳 PDF：從 PDF 讀取音名比從照片可靠得多，有些照片甚至完全無法辨識。如果是照片，請把樂譜平放在均勻的光線下，
        並讓它填滿畫面。音名是自動辨識的，請對照原譜檢查；你可以在樂譜頁面上更正音名。
      </p>

      <h2>刪除你的資料</h2>
      <p>
        在<Link href={path("/history")}>樂譜庫</Link>中刪除樂譜。要刪除帳號，請在頁面頂端你的名字下方的選單中選擇「刪除帳號」。
        刪除帳號不會取消訂閱，所以請先取消訂閱。<Link href={path("/privacy")}>隱私權政策</Link>說明了我們保留哪些內容，
        以及如何申請刪除其他任何內容。
      </p>

      <p>
        另請參閱<Link href={path("/terms")}>使用條款</Link>。
      </p>
    </div>
  );
}
