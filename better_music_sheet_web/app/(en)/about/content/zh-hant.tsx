import Link from "next/link";
import { BackButton } from "../../../back-button";

export function AboutZhHant({ path }: { path: (p: string) => string }) {
  return (
    <div className="wrap medium legal">
      <div className="page-title-row">
        <BackButton />
        <h1 className="serif">關於</h1>
      </div>
      <div className="sub">它能做什麼，又做不到什麼</div>

      <p>
        讀譜，就是把線上的一個點變成音名，再變成手指下的一個琴鍵。熟練的演奏者早已察覺不到這一步，
        其他人卻得在彈奏途中做算術。
      </p>
      <p>
        BetterMusicSheet 替您完成這一步。上傳鋼琴譜的 PDF 或照片，您會拿回同一份樂譜，每個音符都標好了音名，
        還有一個練習模式，在音符響起時於鍵盤上點亮它們。
      </p>

      <h2>標註的意義</h2>
      <p>
        每個符頭上都標有它的音名——<code>C</code>、<code>F♯</code>、<code>B♭</code>——
        距離夠近，彈奏時一眼就能看清，又不會蓋住底下的記譜。同時發聲的音符會歸為一組，
        所以一個和弦讀起來是一個標註，而不是一疊標註。
      </p>
      <p>
        您可以在升記號與降記號寫法之間切換；還在找中央 C 的話，可以加上八度編號；也可以依譜架的遠近調整標註大小。
        除了字母音名，也可以顯示為簡譜數字（1 2 3）或唱名（do re mi）。
      </p>

      <h2>運作方式</h2>
      <p>
        辨識使用開源光學樂譜辨識（OMR）引擎{" "}
        <a href="https://github.com/Audiveris/audiveris" target="_blank" rel="noreferrer noopener">
          Audiveris
        </a>
        。它會找出譜表、譜號、調號和符頭，並推算出每個音符的音高。接著網站把標註畫到您的 PDF 副本上，
        並建立用於播放的時間軸。您的檔案在本站自己的伺服器上處理，不會傳送給第三方服務。
      </p>
      <p>辨識效果不佳的頁面會自動以更高解析度重新辨識，這對排版密集的樂譜和照片都有幫助。</p>

      <h2>它不擅長什麼</h2>
      <p>光學樂譜辨識確實很難，與其事後驚訝，不如事先了解它的限制：</p>
      <ul>
        <li>
          <strong>照片</strong>可以使用，但平整、光線均勻、正對拍攝的照片效果遠比斜拍的好。真正的 PDF 永遠最好。
        </li>
        <li>
          <strong>手寫樂譜</strong>大多無法辨識。
        </li>
        <li>
          <strong>密集段落</strong>——快速音群、密集的加線、大量裝飾音——比簡單的寫法更容易漏掉音符。
        </li>
        <li>
          <strong>播放節奏只是近似值。</strong>讀不出拍號時，時值是推測的，結果可能會逐漸偏差。
        </li>
      </ul>
      <p>在依賴結果之前，請先對照原譜檢查。它是讀譜的輔助工具，而不是校對員。</p>

      <h2>費用與帳號</h2>
      <p>
        試用內建範例不需要帳號。上傳您自己的樂譜需要一個帳號，這樣同一份樂譜在任何地方登入都能找到。
        免費帳號一次保留一份樂譜，練習模式只播放前兩行；進階版可以保留任意數量的樂譜，並解鎖完整的練習模式。
        您的檔案會如何處理，請參閱<Link href={path("/privacy")}>隱私權政策</Link>。
      </p>

      <h2>聯絡我們</h2>
      <p>
        歡迎將更正、錯誤回報以及辨識得不好的樂譜寄到{" "}
        <a href="mailto:bettermusicsheet@gmail.com">bettermusicsheet@gmail.com</a>
        。一份辨識出錯的樂譜對我們非常有幫助。
      </p>
    </div>
  );
}
