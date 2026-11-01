export const evaluationMetrics = [
 {name:'Precision',direction:'max',formula:'TP / (TP + FP)'},
 {name:'Recall',direction:'max',formula:'TP / (TP + FN)'},
 {name:'F1 score',direction:'max',formula:'2TP / (2TP + FP + FN)'},
 {name:'FPR',direction:'min',formula:'FP / (FP + TN)'},
 {name:'Accuracy',direction:'max',formula:'(TP + TN) / 全部样本'},
 {name:'FNR',direction:'min',formula:'FN / (FN + TP)'},
 {name:'Specificity',direction:'max',formula:'TN / (TN + FP)'},
 {name:'Balanced Accuracy',direction:'max',formula:'(Recall + Specificity) / 2'},
 {name:'MCC',direction:'max',formula:'(TP×TN − FP×FN) / √((TP+FP)(TP+FN)(TN+FP)(TN+FN))'},
 {name:'ROC-AUC',direction:'max',formula:'需要预测分数，不能由矩阵计算'},
 {name:'PR-AUC',direction:'max',formula:'需要预测分数，不能由矩阵计算'}
] as const;
export const defaultEvaluationMetrics=['Precision','Recall','F1 score','FPR'];
export interface BinaryConfusionMatrix {tn:number;fp:number;fn:number;tp:number;negative_label:string;positive_label:string}
export function calculateBinaryMetrics(matrix:BinaryConfusionMatrix):Record<string,number|undefined>{
 const {tn,fp,fn,tp}=matrix;if(![tn,fp,fn,tp].every(value=>Number.isSafeInteger(value)&&value>=0))return {};
 const ratio=(a:number,b:number)=>b===0?undefined:a/b;
 const recall=ratio(tp,tp+fn),specificity=ratio(tn,tn+fp);
 const denominator=Math.sqrt((tp+fp)*(tp+fn)*(tn+fp)*(tn+fn));
 return {Precision:ratio(tp,tp+fp),Recall:recall,'F1 score':ratio(2*tp,2*tp+fp+fn),FPR:ratio(fp,fp+tn),Accuracy:ratio(tp+tn,tp+tn+fp+fn),FNR:ratio(fn,fn+tp),Specificity:specificity,'Balanced Accuracy':recall===undefined||specificity===undefined?undefined:(recall+specificity)/2,MCC:ratio(tp*tn-fp*fn,denominator)};
}
