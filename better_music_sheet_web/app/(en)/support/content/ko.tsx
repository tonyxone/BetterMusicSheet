import Link from "next/link";
import { BackButton } from "../../../back-button";

export function SupportKo({ path }: { path: (p: string) => string }) {
  return (
    <div className="wrap medium legal">
      <div className="page-title-row">
        <BackButton />
        <h1 className="serif">고객 지원</h1>
      </div>
      <div className="sub">최종 업데이트: 2026년 9월 28일</div>

      <h2>문의하기</h2>
      <p>
        질문, 버그 신고, 잘못 읽힌 악보는 모두{" "}
        <a href="mailto:bettermusicsheet@gmail.com">bettermusicsheet@gmail.com</a>
        으로 보내 주세요. 사용 중인 브라우저를 알려 주시고, 악보가 잘못 읽혔다면 그 악보를 첨부해 주세요.
      </p>

      <h2>무료와 프리미엄</h2>
      <p>
        무료 계정은 한 번에 악보 1개를 보관합니다(다른 악보를 업로드하려면 지금 있는 악보를 삭제하세요). 연습 모드는 악보의 처음 두 줄을 재생합니다.
        프리미엄은 악보를 원하는 만큼 보관하고 연습 모드 전체를 쓸 수 있습니다.
      </p>

      <h2>구독 관리 및 해지</h2>
      <p>
        <Link href={path("/subscription")}>구독 페이지</Link>에서 요금제를 바꾸거나 해지할 수 있습니다. 해지해도 결제한 기간이 끝날 때까지 프리미엄이 유지됩니다.
      </p>

      <h2>결제했는데 프리미엄이 보이지 않아요</h2>
      <p>
        구독은 구매한 계정에 속합니다. 그 계정으로 로그인했는지 확인한 뒤 페이지를 새로 고침하세요. 그래도 보이지 않으면 이메일로 알려 주세요.
      </p>

      <h2>가장 좋은 결과를 얻으려면</h2>
      <p>
        가능하면 PDF를 업로드하세요. 음이름은 사진보다 PDF에서 훨씬 정확하게 읽히며, 어떤 사진은 아예 읽지 못하기도 합니다. 사진이라면 악보를 평평하게 놓고
        고른 조명 아래에서 화면을 가득 채우도록 찍으세요. 음이름은 자동으로 인식되므로 원본 악보와 대조해 확인하세요. 악보 페이지에서 음이름을 고칠 수 있습니다.
      </p>

      <h2>데이터 삭제</h2>
      <p>
        악보는 <Link href={path("/history")}>보관함</Link>에서 삭제할 수 있습니다. 계정을 삭제하려면 페이지 상단의 이름 아래 메뉴에서 &lsquo;계정 삭제&rsquo;를 선택하세요.
        계정을 삭제해도 구독은 해지되지 않으므로 먼저 해지하세요. <Link href={path("/privacy")}>개인정보 처리방침</Link>에서 보관되는 내용과
        그 밖의 삭제를 요청하는 방법을 확인할 수 있습니다.
      </p>

      <p>
        <Link href={path("/terms")}>이용약관</Link>도 함께 확인하세요.
      </p>
    </div>
  );
}
